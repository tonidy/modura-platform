package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/api"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/store"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/testdb"
)

const (
	cashier   = "cashier-token"
	viewer    = "viewer-token"
	publisher = "publisher-token"
)

type harness struct {
	t      *testing.T
	server *httptest.Server
	spec   *openapi3.T
	db     *pgxpool.Pool
}

func withKey(key string) map[string]string {
	return map[string]string{"Idempotency-Key": key}
}

func (h *harness) count(query string) int {
	h.t.Helper()
	var n int
	if err := h.db.QueryRow(context.Background(), query).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func replayed(res response) string {
	return res.header.Get("Idempotent-Replayed")
}

func newHarness(t *testing.T) *harness {
	return newHarnessWith(t, store.Options{})
}

func newHarnessWith(t *testing.T, opts store.Options) *harness {
	return newHarnessConfig(t, opts, nil)
}

// newHarnessConfig lets a test adjust the handler Config, for example to turn on
// rate limiting.
func newHarnessConfig(t *testing.T, opts store.Options, adjust func(*Config)) *harness {
	t.Helper()
	db := testdb.New(t)
	cfg := Config{
		Store:      store.New(db, opts),
		Identities: DemoIdentities(cashier, viewer, publisher),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if adjust != nil {
		adjust(&cfg)
	}
	handler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := api.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &harness{t: t, server: server, spec: spec, db: db}
}

type response struct {
	status int
	header http.Header
	body   map[string]any
}

// call sends a real HTTP request and checks the real response against the generated
// OpenAPI document: the status must be declared, the body must match its schema, and
// an error code must be one the contract lists for that status.
//
// It is safe to use from several goroutines: failures are reported with Errorf.
func (h *harness) call(token, operation string, body any, headers map[string]string) response {
	h.t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		h.t.Errorf("marshal request: %v", err)
		return response{}
	}
	path := "/v1/" + operation
	req, err := http.NewRequest(http.MethodPost, h.server.URL+path, bytes.NewReader(payload))
	if err != nil {
		h.t.Errorf("build request: %v", err)
		return response{}
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Errorf("send request: %v", err)
		return response{}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		h.t.Errorf("read response: %v", err)
		return response{}
	}

	item := h.spec.Paths.Value(path)
	if item == nil || item.Post == nil {
		h.t.Errorf("%s is not in the contract", path)
		return response{}
	}
	options := &openapi3filter.Options{
		IncludeResponseStatus: true,
		AuthenticationFunc:    openapi3filter.NoopAuthenticationFunc,
	}
	err = openapi3filter.ValidateResponse(context.Background(), &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{
			Request: req,
			Route:   &routers.Route{Spec: h.spec, Path: path, PathItem: item, Method: http.MethodPost, Operation: item.Post},
			Options: options,
		},
		Status:  res.StatusCode,
		Header:  res.Header,
		Body:    io.NopCloser(bytes.NewReader(raw)),
		Options: options,
	})
	if err != nil {
		h.t.Errorf("%s %d response violates the contract: %v\nbody: %s", operation, res.StatusCode, err, raw)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		h.t.Errorf("response is not JSON: %s", raw)
	}
	if declared := item.Post.Responses.Status(res.StatusCode); res.StatusCode >= 400 && declared != nil {
		codes, _ := stringList(declared.Value.Extensions["x-modura-error-codes"])
		if code, _ := decoded["code"].(string); !slices.Contains(codes, code) {
			h.t.Errorf("%s returned %q with status %d, but the contract lists %v", operation, code, res.StatusCode, codes)
		}
	}
	return response{status: res.StatusCode, header: res.Header, body: decoded}
}

func expect(t *testing.T, got response, status int, code string) {
	t.Helper()
	if got.status != status {
		t.Fatalf("status = %d, want %d (body %v)", got.status, status, got.body)
	}
	if code != "" && got.body["code"] != code {
		t.Fatalf("code = %v, want %s (body %v)", got.body["code"], code, got.body)
	}
}

func TestAuthorizationComesFromTheContract(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	list := map[string]any{}

	expect(t, h.call("", "registry.listReleases", list, nil), 401, codeUnauthenticated)
	expect(t, h.call("wrong", "registry.listReleases", list, nil), 401, codeUnauthenticated)
	expect(t, h.call(viewer, "registry.listReleases", list, nil), 200, "")
	expect(t, h.call(cashier, "registry.listReleases", list, nil), 200, "")

	forbidden := h.call(viewer, "registry.publishRelease", map[string]any{"ir": currentIR(t)},
		withKey("4b0ff1b6-6a3c-4d3e-9a51-2a8e8f3f1c10"))
	expect(t, forbidden, 403, codeForbidden)
	if details, _ := forbidden.body["details"].(map[string]any); details["permission"] != "registry.write" {
		t.Fatalf("details = %v, want the missing permission", forbidden.body["details"])
	}
}

func TestIdempotencyKeyIsRequiredAndValidated(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	publish := map[string]any{"ir": currentIR(t)}

	missing := h.call(publisher, "registry.publishRelease", publish, nil)
	expect(t, missing, 400, codeValidationFailed)
	if details, _ := missing.body["details"].(map[string]any); details["parameter"] != "Idempotency-Key" {
		t.Fatalf("details = %v, want the missing header", missing.body["details"])
	}

	expect(t, h.call(publisher, "registry.publishRelease", publish, map[string]string{"Idempotency-Key": "not-a-uuid"}), 400, codeValidationFailed)
}

func TestCommandsAreRateLimitedPerClientIP(t *testing.T) {
	t.Parallel()
	h := newHarnessConfig(t, store.Options{}, func(cfg *Config) {
		cfg.ClientIPHeader = "Fly-Client-IP"
		cfg.CommandRateLimit = 0.001 // effectively no refill during the test
		cfg.CommandBurst = 2
	})
	// An invalid document is rejected after the rate limit is applied, which is all
	// this test looks at.
	publish := func(ip string) response {
		return h.call(publisher, "registry.publishRelease", map[string]any{"ir": "hello"},
			map[string]string{"Idempotency-Key": uuid.NewString(), "Fly-Client-IP": ip})
	}

	expect(t, publish("203.0.113.7"), http.StatusUnprocessableEntity, codeInvalidIR)
	expect(t, publish("203.0.113.7"), http.StatusUnprocessableEntity, codeInvalidIR)
	limited := publish("203.0.113.7")
	expect(t, limited, http.StatusTooManyRequests, codeRateLimited)
	if limited.header.Get("Retry-After") == "" || limited.body["retryable"] != true {
		t.Fatalf("RATE_LIMITED should be retryable with Retry-After, got %v %v", limited.header, limited.body)
	}

	// Another client has its own bucket, and queries are never limited.
	expect(t, publish("198.51.100.4"), http.StatusUnprocessableEntity, codeInvalidIR)
	for range 5 {
		expect(t, h.call(viewer, "registry.listReleases", map[string]any{},
			map[string]string{"Fly-Client-IP": "203.0.113.7"}), http.StatusOK, "")
	}
}

func TestHealthIsOpen(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	res, err := http.Get(h.server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("/healthz = %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

// TestErrorCatalogMatchesIR keeps the Go error table in sync with the contract.
func TestErrorCatalogMatchesIR(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(testdb.Root(t), "generated", "ir", "modura.ir.json"))
	if err != nil {
		t.Fatal(err)
	}
	type definition struct {
		Category  string `json:"category"`
		Retryable bool   `json:"retryable"`
	}
	var ir struct {
		PlatformErrors map[string]definition `json:"platformErrors"`
		Modules        map[string]struct {
			Errors map[string]definition `json:"errors"`
		} `json:"modules"`
	}
	if err := json.Unmarshal(raw, &ir); err != nil {
		t.Fatal(err)
	}
	contract := map[string]definition{}
	for code, def := range ir.PlatformErrors {
		contract[code] = def
		if _, ok := errorCatalog[code]; !ok {
			t.Errorf("platform error %s is missing from the Go catalog", code)
		}
	}
	for module, m := range ir.Modules {
		for code, def := range m.Errors {
			contract[module+"."+code] = def
		}
	}
	for code, spec := range errorCatalog {
		def, ok := contract[code]
		if !ok {
			t.Errorf("Go catalog has %s, which the contract does not define", code)
			continue
		}
		if def.Category != spec.category || def.Retryable != spec.retryable {
			t.Errorf("%s: Go has (%s, retryable=%v), contract has (%s, retryable=%v)",
				code, spec.category, spec.retryable, def.Category, def.Retryable)
		}
		if _, ok := categoryStatus[spec.category]; !ok {
			t.Errorf("%s: category %s has no HTTP status", code, spec.category)
		}
	}
}
