package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/testdb"
)

// Registry tests (plan M5, ADR-0008). Documents start from the real generated IR, so
// the registry is exercised with exactly what `modura publish` sends.

func currentIR(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(testdb.Root(t), "generated", "ir", "modura.ir.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// edit returns a deep copy of doc with fn applied.
func edit(t *testing.T, doc map[string]any, fn func(map[string]any)) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(doc)
	var copied map[string]any
	_ = json.Unmarshal(raw, &copied)
	fn(copied)
	return copied
}

func object(v any, keys ...string) map[string]any {
	for _, key := range keys {
		v = v.(map[string]any)[key]
	}
	return v.(map[string]any)
}

// changeFields are the fields of registry.Change, which listReleases and getRelease return.
func changeFields(doc map[string]any) map[string]any {
	return object(doc, "types", "registry.Change", "fields")
}

func withReservedField(doc map[string]any) {
	changeFields(doc)["reserved"] = map[string]any{"required": false, "type": map[string]any{"kind": "integer"}}
}

func (h *harness) publish(token string, doc map[string]any, basedOn int, key string) response {
	h.t.Helper()
	body := map[string]any{"ir": doc}
	if basedOn > 0 {
		body["basedOn"] = basedOn
	}
	return h.call(token, "registry.publishRelease", body, withKey(key))
}

func TestRegistryPublishLifecycle(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	base := currentIR(t)

	expect(t, h.call(viewer, "registry.getRelease", map[string]any{}, nil), http.StatusNotFound, codeReleaseNotFound)

	first := h.publish(publisher, base, 0, uuid.NewString())
	expect(t, first, http.StatusOK, "")
	summary := object(first.body, "summary")
	if summary["number"] != float64(1) || summary["publishedBy"] != "publisher" {
		t.Fatalf("first release summary = %v", summary)
	}
	if changes := first.body["changes"].([]any); len(changes) != 0 {
		t.Fatalf("first release has changes %v, want none", changes)
	}

	got := h.call(viewer, "registry.getRelease", map[string]any{}, nil)
	expect(t, got, http.StatusOK, "")
	if !reflect.DeepEqual(got.body["ir"], any(base)) {
		t.Fatal("getRelease did not return the published IR")
	}
	canonical, _ := json.Marshal(base)
	sum := sha256.Sum256(canonical)
	if object(got.body, "release", "summary")["irSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatal("irSha256 is not the SHA-256 of the canonical document")
	}

	expect(t, h.publish(publisher, base, 1, uuid.NewString()), http.StatusUnprocessableEntity, codeNothingToPublish)

	second := h.publish(publisher, edit(t, base, withReservedField), 1, uuid.NewString())
	expect(t, second, http.StatusOK, "")
	changes := second.body["changes"].([]any)
	// registry.Change is returned by getRelease and publishRelease, so it is reported twice.
	want := []any{
		map[string]any{"module": "registry", "path": "registry.getRelease.output.release.changes[].reserved", "message": "field added", "severity": "safe"},
		map[string]any{"module": "registry", "path": "registry.publishRelease.output.changes[].reserved", "message": "field added", "severity": "safe"},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes = %v, want %v", changes, want)
	}

	list := h.call(viewer, "registry.listReleases", map[string]any{}, nil)
	expect(t, list, http.StatusOK, "")
	releases := list.body["releases"].([]any)
	if len(releases) != 2 || releases[0].(map[string]any)["number"] != float64(2) {
		t.Fatalf("releases = %v, want 2 then 1", releases)
	}
	old := h.call(viewer, "registry.getRelease", map[string]any{"number": 1}, nil)
	if !reflect.DeepEqual(old.body["ir"], any(base)) {
		t.Fatal("release 1 changed after release 2 was published")
	}
}

func TestRegistryRejectsUnversionedBreakingChangesOnTheServer(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	base := currentIR(t)
	expect(t, h.publish(publisher, base, 0, uuid.NewString()), http.StatusOK, "")

	breaking := edit(t, base, func(doc map[string]any) { delete(changeFields(doc), "message") })
	rejected := h.publish(publisher, breaking, 1, uuid.NewString())
	expect(t, rejected, http.StatusUnprocessableEntity, codeIncompatibleChange)
	details := rejected.body["details"].(map[string]any)
	violations := details["violations"].([]any)
	if len(violations) != 1 || !strings.HasPrefix(violations[0].(string), "registry: breaking changes need a major version bump") {
		t.Fatalf("violations = %v", violations)
	}
	wantChanges := []any{
		map[string]any{"module": "registry", "path": "registry.getRelease.output.release.changes[].message", "message": "field removed", "severity": "breaking"},
		map[string]any{"module": "registry", "path": "registry.publishRelease.output.changes[].message", "message": "field removed", "severity": "breaking"},
	}
	if !reflect.DeepEqual(details["changes"], wantChanges) {
		t.Fatalf("changes = %v, want %v", details["changes"], wantChanges)
	}

	bumped := edit(t, breaking, func(doc map[string]any) { object(doc, "modules", "registry")["version"] = "0.3.0" })
	expect(t, h.publish(publisher, bumped, 1, uuid.NewString()), http.StatusOK, "")
}

func TestRegistryConcurrentPublishesFromTheSameBase(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	base := currentIR(t)
	expect(t, h.publish(publisher, base, 0, uuid.NewString()), http.StatusOK, "")

	stale := h.publish(publisher, edit(t, base, withReservedField), 0, uuid.NewString())
	expect(t, stale, http.StatusConflict, codeStaleBase)
	if stale.body["details"].(map[string]any)["latest"] != float64(1) {
		t.Fatalf("details = %v, want latest 1", stale.body["details"])
	}

	// Two publishers compared against release 1 and publish different changes at once.
	a := edit(t, base, withReservedField)
	b := edit(t, base, func(doc map[string]any) {
		changeFields(doc)["location"] = map[string]any{"required": false, "type": map[string]any{"kind": "string"}}
	})
	results := make([]response, 2)
	var wg sync.WaitGroup
	for i, doc := range []map[string]any{a, b} {
		wg.Go(func() { results[i] = h.publish(publisher, doc, 1, uuid.NewString()) })
	}
	wg.Wait()

	statuses := []int{results[0].status, results[1].status}
	if !(statuses[0] == 200 && statuses[1] == 409 || statuses[0] == 409 && statuses[1] == 200) {
		t.Fatalf("statuses = %v, want exactly one 200 and one 409", statuses)
	}
	for _, res := range results {
		if res.status == 409 && res.body["code"] != codeStaleBase {
			t.Fatalf("the losing publish got %v, want STALE_BASE", res.body["code"])
		}
	}
}

func TestRegistryPublishIsIdempotent(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	base := currentIR(t)
	key := uuid.NewString()

	first := h.publish(publisher, base, 0, key)
	retry := h.publish(publisher, base, 0, key)

	expect(t, first, http.StatusOK, "")
	expect(t, retry, http.StatusOK, "")
	if replayed(retry) != "true" || !reflect.DeepEqual(retry.body, first.body) {
		t.Fatalf("retry = %v (replayed %q), want a replay of the first publish", retry.body, replayed(retry))
	}
	if n := h.count(`SELECT count(*) FROM contract_releases`); n != 1 {
		t.Fatalf("%d releases after a retried publish, want 1", n)
	}
}

func TestRegistryAuthorizationAndValidation(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	base := currentIR(t)

	expect(t, h.publish(viewer, base, 0, uuid.NewString()), http.StatusForbidden, codeForbidden)
	expect(t, h.publish(cashier, base, 0, uuid.NewString()), http.StatusForbidden, codeForbidden)
	expect(t, h.call(cashier, "registry.listReleases", map[string]any{}, nil), http.StatusOK, "")

	wrongVersion := edit(t, base, func(doc map[string]any) { doc["irVersion"] = "9.9.9" })
	expect(t, h.publish(publisher, wrongVersion, 0, uuid.NewString()), http.StatusUnprocessableEntity, codeInvalidIR)
	// Pre-1.0 documents can be read (old releases) but not published.
	legacy := edit(t, base, func(doc map[string]any) { doc["irVersion"] = "0.2.0" })
	expect(t, h.publish(publisher, legacy, 0, uuid.NewString()), http.StatusUnprocessableEntity, codeInvalidIR)
	// A newer 1.x minor may add fields this reader does not know; they are ignored.
	newerMinor := edit(t, base, func(doc map[string]any) {
		doc["irVersion"] = "1.1.0"
		doc["futureField"] = map[string]any{"anything": true}
	})
	expect(t, h.publish(publisher, newerMinor, 0, uuid.NewString()), http.StatusOK, "")
	danglingRef := edit(t, base, func(doc map[string]any) { delete(object(doc, "types"), "registry.ReleaseNumber") })
	expect(t, h.publish(publisher, danglingRef, 0, uuid.NewString()), http.StatusUnprocessableEntity, codeInvalidIR)
	notADocument := h.call(publisher, "registry.publishRelease", map[string]any{"ir": "hello"}, withKey(uuid.NewString()))
	expect(t, notADocument, http.StatusUnprocessableEntity, codeInvalidIR)

	if _, ok := DemoIdentities("c", "v", "")["" /* never a token */]; ok {
		t.Fatal("an empty publisher token must not create an identity")
	}
	if len(DemoIdentities("c", "v", "")) != 2 {
		t.Fatal("without a publisher token there must be no publisher")
	}
}
