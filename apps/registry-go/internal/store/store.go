// Package store reads and writes the registry's Postgres schema (migrations/).
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrNotFound means the requested row does not exist.
	ErrNotFound = errors.New("not found")
	// ErrIdempotencyKeyReused means the key was already used for a different request.
	ErrIdempotencyKeyReused = errors.New("idempotency key reused with a different request")
	// ErrIdempotencyInProgress means another request holding the key did not finish
	// within Options.ClaimTimeout.
	ErrIdempotencyInProgress = errors.New("another request with this idempotency key is still running")
	// ErrBusy means the release lock stayed taken longer than Options.LockTimeout.
	ErrBusy = errors.New("another publish held the release lock past the lock timeout")
)

type Store struct {
	db   *pgxpool.Pool
	opts Options
}

type Options struct {
	// ClaimTimeout bounds how long a publish waits for another request holding the
	// same idempotency key. Default 2s. Exceeding it is ErrIdempotencyInProgress.
	ClaimTimeout time.Duration
	// LockTimeout bounds how long a publish waits for the release lock.
	// Default 5s. Exceeding it is ErrBusy.
	LockTimeout time.Duration
}

func New(db *pgxpool.Pool, opts Options) *Store {
	if opts.ClaimTimeout <= 0 {
		opts.ClaimTimeout = 2 * time.Second
	}
	if opts.LockTimeout <= 0 {
		opts.LockTimeout = 5 * time.Second
	}
	return &Store{db: db, opts: opts}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.Ping(ctx)
}

// IsUnavailable reports whether err is transient (the database is unreachable or
// busy) as opposed to a bug. It decides between UNAVAILABLE (retryable) and INTERNAL.
func IsUnavailable(err error) bool {
	var connectErr *pgconn.ConnectError
	if errors.As(err, &connectErr) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrBusy) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "40001", "40P01", "57P01": // serialization failure, deadlock, admin shutdown
			return true
		}
	}
	return false
}

func setLockTimeout(ctx context.Context, tx pgx.Tx, timeout time.Duration) error {
	_, err := tx.Exec(ctx, `SELECT set_config('lock_timeout', $1, true)`,
		fmt.Sprintf("%dms", timeout.Milliseconds()))
	if err != nil {
		return fmt.Errorf("set lock_timeout: %w", err)
	}
	return nil
}

func isLockTimeout(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "55P03" // lock_not_available
}
