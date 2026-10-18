// Command registry-api serves the Contract Registry, the standalone service that
// stores published contract releases (plan M5, ADR-0008, ADR-0013).
//
// Usage:
//
//	registry-api [serve]  apply pending migrations, serve
//	registry-api migrate  apply pending migrations, then exit
//
// The registry keeps its data in its own Postgres schema, "registry", inside the
// database DATABASE_URL names. The service creates the schema if it is missing.
//
// Environment:
//
//	DATABASE_URL             Postgres connection string (required)
//	PORT                     listen port, default 8081
//	MODURA_MIGRATIONS_DIR    directory with the SQL migrations, default migrations
//	MODURA_VIEWER_TOKEN      public viewer bearer token (registry.read), default "demo-viewer"
//	MODURA_CASHIER_TOKEN     public POS demo token (registry.read), default "demo-cashier"
//	MODURA_PUBLISHER_TOKEN   secret token allowed to publish releases (registry.read and
//	                         registry.write); unset disables publishing
//	MODURA_CLIENT_IP_HEADER  trusted proxy header with the client IP, e.g. Fly-Client-IP
//	MODURA_COMMANDS_PER_MIN  per-IP command rate limit, default 30 (0 disables)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/dbmigrate"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/httpapi"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/store"
)

const schema = "registry"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if err := run(command, logger); err != nil {
		logger.Error("registry-api failed", "command", command, "error", err)
		os.Exit(1)
	}
}

func run(command string, logger *slog.Logger) error {
	if command != "serve" && command != "migrate" {
		return fmt.Errorf("unknown command %q (want serve or migrate)", command)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	// Every pooled connection reads and writes the registry schema only.
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := migrate(ctx, pool, env("MODURA_MIGRATIONS_DIR", "migrations"), logger); err != nil {
		return err
	}
	if command == "migrate" {
		return nil
	}
	return serve(ctx, pool, logger)
}

func migrate(ctx context.Context, pool *pgxpool.Pool, dir string, logger *slog.Logger) error {
	if err := dbmigrate.EnsureSchema(ctx, pool, schema); err != nil {
		return err
	}
	applied, err := dbmigrate.Apply(ctx, pool, dir)
	if err != nil {
		return err
	}
	logger.Info("database ready", "schema", schema, "applied", applied)
	return nil
}

func serve(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	perMinute, err := strconv.Atoi(env("MODURA_COMMANDS_PER_MIN", "30"))
	if err != nil {
		return fmt.Errorf("MODURA_COMMANDS_PER_MIN: %w", err)
	}
	handler, err := httpapi.New(httpapi.Config{
		Store: store.New(pool, store.Options{}),
		Identities: httpapi.DemoIdentities(
			env("MODURA_CASHIER_TOKEN", "demo-cashier"),
			env("MODURA_VIEWER_TOKEN", "demo-viewer"),
			os.Getenv("MODURA_PUBLISHER_TOKEN"), // secret; unset means publishing is off
		),
		Logger:           logger,
		ClientIPHeader:   os.Getenv("MODURA_CLIENT_IP_HEADER"),
		CommandRateLimit: rate.Limit(float64(perMinute) / 60),
		CommandBurst:     max(5, perMinute/3),
	})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              ":" + env("PORT", "8081"),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errs := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		errs <- srv.ListenAndServe()
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
