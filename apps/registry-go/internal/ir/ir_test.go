package ir

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/testdb"
)

// The shared IR fixtures are written by packages/compiler/src/ir-fixtures.test.ts.
// Go must judge every one the way the TypeScript validator does, and compute the
// same canonical hash for every valid one.

func fixtures(t *testing.T, kind string) map[string][]byte {
	t.Helper()
	dir := filepath.Join(testdb.Root(t), "tests", "ir-fixtures", kind)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]byte{}
	for _, entry := range entries {
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[strings.TrimSuffix(entry.Name(), ".json")] = raw
	}
	if len(out) == 0 {
		t.Fatalf("no fixtures in %s", dir)
	}
	return out
}

// publishable is what "valid" means for a fixture: parseable and allowed as a new release.
func publishable(raw []byte) error {
	doc, err := Parse(raw)
	if err != nil {
		return err
	}
	if !IsPublishable(doc.IRVersion) {
		return fmt.Errorf("IR %s is readable but cannot be published", doc.IRVersion)
	}
	return nil
}

func TestAcceptsEveryValidFixture(t *testing.T) {
	for name, raw := range fixtures(t, "valid") {
		if err := publishable(raw); err != nil {
			t.Errorf("valid/%s rejected: %v", name, err)
		}
	}
}

func TestRejectsEveryInvalidFixture(t *testing.T) {
	for name, raw := range fixtures(t, "invalid") {
		if err := publishable(raw); err == nil {
			t.Errorf("invalid/%s was accepted", name)
		} else {
			t.Logf("invalid/%s: %v", name, err)
		}
	}
}

func TestReferenceCyclesAreReportedNotFollowed(t *testing.T) {
	_, err := Parse(fixtures(t, "invalid")["reference-cycle"])
	if err == nil || err.Error() != "types: reference cycle shop.Item -> shop.Item" {
		t.Fatalf("err = %v", err)
	}
}

func TestCanonicalHashMatchesTypeScript(t *testing.T) {
	root := testdb.Root(t)
	raw, err := os.ReadFile(filepath.Join(root, "tests", "ir-fixtures", "hashes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]string
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	if len(expected) < 2 {
		t.Fatalf("hashes.json has only %d entries", len(expected))
	}
	// The real IR's hash is written by `modura generate` next to it.
	sum, err := os.ReadFile(filepath.Join(root, "generated", "ir", "modura.ir.sha256"))
	if err != nil {
		t.Fatal(err)
	}
	expected["../../generated/ir/modura.ir.json"] = strings.TrimSpace(string(sum))

	for path, want := range expected {
		doc, err := os.ReadFile(filepath.Join(root, "tests", "ir-fixtures", path))
		if err != nil {
			t.Fatal(err)
		}
		_, got, err := Canonical(doc)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if got != want {
			t.Errorf("%s: Go hash %s, TypeScript hash %s", path, got, want)
		}
	}
}
