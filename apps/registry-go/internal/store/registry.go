package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/compat"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/ir"
)

const publishReleaseOperation = "registry.publishRelease"

type PublishRejectionReason int

const (
	InvalidIR PublishRejectionReason = iota + 1
	IncompatibleChange
	StaleBase
	NothingToPublish
)

// PublishRejection is a reason a release cannot be published. Like a checkout
// rejection, nothing is written and the idempotency key stays free.
type PublishRejection struct {
	Reason  PublishRejectionReason
	Message string
	Details map[string]any
}

func (r *PublishRejection) Error() string { return r.Message }

type PublishRequest struct {
	// Scope and Key identify the idempotency record. Scope is the publisher identity.
	Scope       string
	Key         string
	Fingerprint []byte
	// IR is the document as received; it is validated and canonicalized here.
	IR []byte
	// BasedOn is the release the publisher compared against; nil means "none yet".
	BasedOn   *int64
	Publisher string
}

type ModuleVersion struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ReleaseSummary and Release use the contract's JSON field names, because the
// stored idempotency response is exactly what a replay returns.
type ReleaseSummary struct {
	Number      int64           `json:"number"`
	PublishedAt time.Time       `json:"publishedAt"`
	PublishedBy string          `json:"publishedBy"`
	IRVersion   string          `json:"irVersion"`
	IRSha256    string          `json:"irSha256"`
	Modules     []ModuleVersion `json:"modules"`
}

type Release struct {
	Summary ReleaseSummary  `json:"summary"`
	Changes []compat.Change `json:"changes"`
}

type PublishOutcome struct {
	Release  Release
	Replayed bool
}

// PublishRelease stores a new contract release (ADR-0008). In one transaction:
//
//  1. Claim the idempotency key, exactly like checkout (ADR-0004).
//  2. Take a transaction-scoped advisory lock, so publishes are strictly serial.
//     It also covers the very first release, when there is no row to lock.
//  3. Validate the IR and check basedOn against the latest release (STALE_BASE).
//  4. Run the compatibility check against the latest release, on the server.
//  5. Insert the release, store the response for replays, commit.
func (s *Store) PublishRelease(ctx context.Context, req PublishRequest) (PublishOutcome, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("begin publish: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	claimed, err := claimKey(ctx, tx, req.Scope, req.Key, publishReleaseOperation, req.Fingerprint, s.opts.ClaimTimeout)
	if err != nil {
		return PublishOutcome{}, err
	}
	if !claimed {
		body, err := storedResponse(ctx, tx, req.Scope, req.Key, req.Fingerprint)
		if err != nil {
			return PublishOutcome{}, err
		}
		var release Release
		if err := json.Unmarshal(body, &release); err != nil {
			return PublishOutcome{}, fmt.Errorf("decode stored release: %w", err)
		}
		return PublishOutcome{Release: release, Replayed: true}, nil
	}

	if err := setLockTimeout(ctx, tx, s.opts.LockTimeout); err != nil {
		return PublishOutcome{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.contract_releases'))`); err != nil {
		if isLockTimeout(err) {
			return PublishOutcome{}, ErrBusy
		}
		return PublishOutcome{}, fmt.Errorf("lock releases: %w", err)
	}

	doc, err := ir.Parse(req.IR)
	if err != nil {
		return PublishOutcome{}, &PublishRejection{InvalidIR, "The document is not a valid Modura IR document: " + err.Error(), nil}
	}
	if !ir.IsPublishable(doc.IRVersion) {
		return PublishOutcome{}, &PublishRejection{InvalidIR,
			fmt.Sprintf("IR %s can still be read, but new releases must use IR 1.x.", doc.IRVersion), nil}
	}
	canonical, sha, err := ir.Canonical(req.IR)
	if err != nil {
		return PublishOutcome{}, &PublishRejection{InvalidIR, "The document cannot be canonicalized: " + err.Error(), nil}
	}

	var latestNumber int64
	var latestIR []byte
	var latestSha string
	err = tx.QueryRow(ctx, `
		SELECT number, ir::text, ir_sha256 FROM contract_releases
		ORDER BY number DESC LIMIT 1`).Scan(&latestNumber, &latestIR, &latestSha)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PublishOutcome{}, fmt.Errorf("read latest release: %w", err)
	}

	var basedOn int64
	if req.BasedOn != nil {
		basedOn = *req.BasedOn
	}
	if basedOn != latestNumber {
		details := map[string]any{"latest": nil}
		if latestNumber > 0 {
			details["latest"] = latestNumber
		}
		return PublishOutcome{}, &PublishRejection{StaleBase,
			fmt.Sprintf("This publish was compared against release %s, but the latest is %s.", describe(basedOn), describe(latestNumber)),
			details}
	}

	changes := []compat.Change{}
	if latestNumber > 0 {
		if sha == latestSha {
			return PublishOutcome{}, &PublishRejection{NothingToPublish,
				fmt.Sprintf("The document is identical to release %d.", latestNumber),
				map[string]any{"latest": latestNumber}}
		}
		previous, err := ir.Parse(latestIR)
		if err != nil {
			return PublishOutcome{}, fmt.Errorf("stored release %d no longer parses: %w", latestNumber, err)
		}
		report := compat.Check(previous, doc)
		if len(report.Violations) > 0 {
			return PublishOutcome{}, &PublishRejection{IncompatibleChange,
				"The release breaks clients: " + report.Violations[0],
				map[string]any{"changes": report.Changes, "violations": report.Violations}}
		}
		changes = report.Changes
	}

	release := Release{
		Summary: ReleaseSummary{
			Number:      latestNumber + 1,
			PublishedBy: req.Publisher,
			IRVersion:   doc.IRVersion,
			IRSha256:    sha,
			Modules:     moduleVersions(doc),
		},
		Changes: changes,
	}
	modulesJSON, _ := json.Marshal(release.Summary.Modules)
	changesJSON, _ := json.Marshal(release.Changes)
	err = tx.QueryRow(ctx, `
		INSERT INTO contract_releases (number, ir, ir_sha256, ir_version, modules, changes, published_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING published_at`,
		release.Summary.Number, string(canonical), sha, doc.IRVersion, modulesJSON, changesJSON, req.Publisher,
	).Scan(&release.Summary.PublishedAt)
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("insert release: %w", err)
	}
	release.Summary.PublishedAt = release.Summary.PublishedAt.UTC()

	body, err := json.Marshal(release)
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("encode release: %w", err)
	}
	if err := completeKey(ctx, tx, req.Scope, req.Key, body); err != nil {
		return PublishOutcome{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PublishOutcome{}, fmt.Errorf("commit publish: %w", err)
	}
	return PublishOutcome{Release: release}, nil
}

// ListReleases returns release summaries, newest first.
func (s *Store) ListReleases(ctx context.Context, limit int) ([]ReleaseSummary, error) {
	rows, err := s.db.Query(ctx, `
		SELECT number, published_at, published_by, ir_version, ir_sha256, modules
		FROM contract_releases ORDER BY number DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list releases: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ReleaseSummary, error) {
		var r ReleaseSummary
		var modules []byte
		if err := row.Scan(&r.Number, &r.PublishedAt, &r.PublishedBy, &r.IRVersion, &r.IRSha256, &modules); err != nil {
			return r, err
		}
		r.PublishedAt = r.PublishedAt.UTC()
		return r, json.Unmarshal(modules, &r.Modules)
	})
}

// GetRelease returns one release and its canonical IR bytes. A nil number means the
// latest. ErrNotFound if there is no such release.
func (s *Store) GetRelease(ctx context.Context, number *int64) (Release, []byte, error) {
	query := `
		SELECT number, published_at, published_by, ir_version, ir_sha256, modules, changes, ir::text
		FROM contract_releases `
	args := []any{}
	if number != nil {
		query += `WHERE number = $1`
		args = append(args, *number)
	} else {
		query += `ORDER BY number DESC LIMIT 1`
	}
	var r Release
	var modules, changes, irText []byte
	err := s.db.QueryRow(ctx, query, args...).Scan(&r.Summary.Number, &r.Summary.PublishedAt, &r.Summary.PublishedBy,
		&r.Summary.IRVersion, &r.Summary.IRSha256, &modules, &changes, &irText)
	if errors.Is(err, pgx.ErrNoRows) {
		return Release{}, nil, ErrNotFound
	}
	if err != nil {
		return Release{}, nil, fmt.Errorf("get release: %w", err)
	}
	r.Summary.PublishedAt = r.Summary.PublishedAt.UTC()
	if err := json.Unmarshal(modules, &r.Summary.Modules); err != nil {
		return Release{}, nil, err
	}
	if err := json.Unmarshal(changes, &r.Changes); err != nil {
		return Release{}, nil, err
	}
	return r, irText, nil
}

func moduleVersions(doc *ir.Document) []ModuleVersion {
	out := make([]ModuleVersion, 0, len(doc.Modules))
	for _, name := range ir.SortedKeys(doc.Modules) {
		out = append(out, ModuleVersion{Name: name, Version: doc.Modules[name].Version})
	}
	return out
}

func describe(number int64) string {
	if number == 0 {
		return "none"
	}
	return fmt.Sprint(number)
}
