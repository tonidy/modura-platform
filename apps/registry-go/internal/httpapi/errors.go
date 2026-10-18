package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/api"
)

// errorSpec mirrors an error definition in the IR. TestErrorCatalogMatchesIR keeps
// this table honest, so the Go service cannot drift from the contract silently.
type errorSpec struct {
	category  string
	retryable bool
}

// categoryStatus mirrors errorCategories in @modura/runtime-contracts (ADR-0003).
var categoryStatus = map[string]int{
	"validation":      http.StatusBadRequest,
	"unauthenticated": http.StatusUnauthorized,
	"forbidden":       http.StatusForbidden,
	"not_found":       http.StatusNotFound,
	"conflict":        http.StatusConflict,
	"unprocessable":   http.StatusUnprocessableEntity,
	"rate_limited":    http.StatusTooManyRequests,
	"internal":        http.StatusInternalServerError,
	"unavailable":     http.StatusServiceUnavailable,
}

const (
	codeValidationFailed      = "VALIDATION_FAILED"
	codeUnauthenticated       = "UNAUTHENTICATED"
	codeForbidden             = "FORBIDDEN"
	codeIdempotencyKeyReused  = "IDEMPOTENCY_KEY_REUSED"
	codeIdempotencyInProgress = "IDEMPOTENCY_IN_PROGRESS"
	codeRateLimited           = "RATE_LIMITED"
	codeInternal              = "INTERNAL"
	codeUnavailable           = "UNAVAILABLE"

	codeReleaseNotFound    = "registry.RELEASE_NOT_FOUND"
	codeInvalidIR          = "registry.INVALID_IR"
	codeIncompatibleChange = "registry.INCOMPATIBLE_CHANGE"
	codeStaleBase          = "registry.STALE_BASE"
	codeNothingToPublish   = "registry.NOTHING_TO_PUBLISH"
)

var errorCatalog = map[string]errorSpec{
	codeValidationFailed:      {"validation", false},
	codeUnauthenticated:       {"unauthenticated", false},
	codeForbidden:             {"forbidden", false},
	codeIdempotencyKeyReused:  {"conflict", false},
	codeIdempotencyInProgress: {"conflict", true},
	codeRateLimited:           {"rate_limited", true},
	codeInternal:              {"internal", false},
	codeUnavailable:           {"unavailable", true},

	codeReleaseNotFound:    {"not_found", false},
	codeInvalidIR:          {"unprocessable", false},
	codeIncompatibleChange: {"unprocessable", false},
	codeStaleBase:          {"conflict", false},
	codeNothingToPublish:   {"unprocessable", false},
}

// newError builds the canonical error body for code, filling in the operation and
// request ID from the request context.
func newError(ctx context.Context, code, message string, details map[string]any) (int, api.Error) {
	spec, ok := errorCatalog[code]
	if !ok {
		panic("httpapi: error code " + code + " is not in the catalog")
	}
	body := api.Error{Code: code, Message: message, Retryable: spec.retryable}
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		body.RequestId = &id
	}
	if operation, ok := ctx.Value(operationKey).(string); ok {
		body.Operation = &operation
	}
	if details != nil {
		body.Details = &details
	}
	return categoryStatus[spec.category], body
}

func writeError(w http.ResponseWriter, r *http.Request, code, message string, details map[string]any) {
	status, body := newError(r.Context(), code, message, details)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
