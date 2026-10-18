package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/api"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/store"
)

// Handlers for the registry module (plan M5, ADR-0008). The compatibility check runs
// in the store, on the server, so no client can publish a breaking change alone.

func (s *server) RegistryPublishRelease(ctx context.Context, request api.RegistryPublishReleaseRequestObject) (api.RegistryPublishReleaseResponseObject, error) {
	raw, err := json.Marshal(request.Body.Ir)
	if err != nil {
		_, body := newError(ctx, codeInvalidIR, "The document is not valid JSON.", nil)
		return api.RegistryPublishRelease422JSONResponse(body), nil
	}
	identity := ctx.Value(identityKey).(Identity)
	outcome, err := s.store.PublishRelease(ctx, store.PublishRequest{
		Scope:       identity.Name,
		Key:         request.Params.IdempotencyKey.String(),
		Fingerprint: publishFingerprint(raw, request.Body.BasedOn),
		IR:          raw,
		BasedOn:     request.Body.BasedOn,
		Publisher:   identity.Name,
	})

	var rejection *store.PublishRejection
	switch {
	case errors.As(err, &rejection):
		_, body := newError(ctx, publishRejectionCodes[rejection.Reason], rejection.Message, rejection.Details)
		if rejection.Reason == store.StaleBase {
			return api.RegistryPublishRelease409JSONResponse(body), nil
		}
		return api.RegistryPublishRelease422JSONResponse(body), nil
	case errors.Is(err, store.ErrIdempotencyKeyReused):
		_, body := newError(ctx, codeIdempotencyKeyReused,
			"This idempotency key was already used for a different publish. Use a new key per attempt.", nil)
		return api.RegistryPublishRelease409JSONResponse(body), nil
	case errors.Is(err, store.ErrIdempotencyInProgress):
		_, body := newError(ctx, codeIdempotencyInProgress,
			"A publish with this idempotency key is still running. Retry shortly with the same key.", nil)
		return api.RegistryPublishRelease409JSONResponse(body), nil
	case err != nil:
		return nil, err
	}

	return api.RegistryPublishRelease200JSONResponse{
		Body:    toAPIRelease(outcome.Release),
		Headers: api.RegistryPublishRelease200ResponseHeaders{IdempotentReplayed: &outcome.Replayed},
	}, nil
}

func (s *server) RegistryListReleases(ctx context.Context, request api.RegistryListReleasesRequestObject) (api.RegistryListReleasesResponseObject, error) {
	limit := 20
	if request.Body.Limit != nil {
		limit = int(*request.Body.Limit)
	}
	summaries, err := s.store.ListReleases(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := api.RegistryListReleases200JSONResponse{Releases: make([]api.RegistryReleaseSummary, 0, len(summaries))}
	for _, summary := range summaries {
		out.Releases = append(out.Releases, toAPISummary(summary))
	}
	return out, nil
}

func (s *server) RegistryGetRelease(ctx context.Context, request api.RegistryGetReleaseRequestObject) (api.RegistryGetReleaseResponseObject, error) {
	release, irBytes, err := s.store.GetRelease(ctx, request.Body.Number)
	if errors.Is(err, store.ErrNotFound) {
		message := "Nothing has been published yet."
		if request.Body.Number != nil {
			message = fmt.Sprintf("There is no release %d.", *request.Body.Number)
		}
		_, body := newError(ctx, codeReleaseNotFound, message, nil)
		return api.RegistryGetRelease404JSONResponse(body), nil
	}
	if err != nil {
		return nil, err
	}
	// The stored canonical bytes go out unchanged.
	return api.RegistryGetRelease200JSONResponse{Release: toAPIRelease(release), Ir: json.RawMessage(irBytes)}, nil
}

var publishRejectionCodes = map[store.PublishRejectionReason]string{
	store.InvalidIR:          codeInvalidIR,
	store.IncompatibleChange: codeIncompatibleChange,
	store.StaleBase:          codeStaleBase,
	store.NothingToPublish:   codeNothingToPublish,
}

// publishFingerprint identifies a publish request for idempotency: same document
// (as sent) and same base.
func publishFingerprint(raw []byte, basedOn *int64) []byte {
	h := sha256.New()
	h.Write([]byte("registry.publishRelease\n"))
	if basedOn != nil {
		fmt.Fprintf(h, "%d\n", *basedOn)
	} else {
		h.Write([]byte("none\n"))
	}
	h.Write(raw)
	return h.Sum(nil)
}

func toAPISummary(s store.ReleaseSummary) api.RegistryReleaseSummary {
	modules := make([]api.RegistryModuleVersion, 0, len(s.Modules))
	for _, m := range s.Modules {
		modules = append(modules, api.RegistryModuleVersion{Name: m.Name, Version: m.Version})
	}
	return api.RegistryReleaseSummary{
		Number:      s.Number,
		PublishedAt: s.PublishedAt,
		PublishedBy: s.PublishedBy,
		IrVersion:   s.IRVersion,
		IrSha256:    s.IRSha256,
		Modules:     modules,
	}
}

func toAPIRelease(r store.Release) api.RegistryRelease {
	changes := make([]api.RegistryChange, 0, len(r.Changes))
	for _, c := range r.Changes {
		changes = append(changes, api.RegistryChange{
			Module: c.Module, Path: c.Path, Message: c.Message, Severity: api.RegistryChangeSeverity(c.Severity),
		})
	}
	return api.RegistryRelease{Summary: toAPISummary(r.Summary), Changes: changes}
}
