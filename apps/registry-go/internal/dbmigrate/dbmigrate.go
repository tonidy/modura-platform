// Package dbmigrate applies the registry's SQL migrations. It is the only migration
// runner: local runs, tests and the deployed service all use it.
package dbmigrate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnsureSchema creates the named schema if it is missing. The registry shares a
// database with other services, so it keeps its tables in a schema of its own.
func EnsureSchema(ctx context.Context, db *pgxpool.Pool, name string) error {
	if _, err := db.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS `+pgx.Identifier{name}.Sanitize()); err != nil {
		return fmt.Errorf("create schema %s: %w", name, err)
	}
	return nil
}

// Apply runs every *.sql file in dir that is not yet recorded in schema_migrations,
// in filename order, each in its own transaction. The pool's search_path decides
// which schema holds schema_migrations and the tables. An advisory lock keyed on the
// current schema keeps concurrent starts from racing.
func Apply(ctx context.Context, db *pgxpool.Pool, dir string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no migrations found in %s", dir)
	}
	sort.Strings(files)

	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext(current_schema()))`); err != nil {
		return nil, fmt.Errorf("lock migrations: %w", err)
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext(current_schema()))`)

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	var applied []string
	for _, file := range files {
		version := strings.TrimSuffix(filepath.Base(file), ".sql")
		var done bool
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version).Scan(&done); err != nil {
			return applied, err
		}
		if done {
			continue
		}
		sql, err := os.ReadFile(file)
		if err != nil {
			return applied, err
		}
		err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version)
			return err
		})
		if err != nil {
			return applied, fmt.Errorf("apply %s: %w", version, err)
		}
		applied = append(applied, version)
	}
	return applied, nil
}
