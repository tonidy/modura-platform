# Modura Contract Registry (Go service)

Standalone Go service for publishing and reading Modura contract releases. This module
is an executable, not a reusable Go SDK; its implementation packages are intentionally
under Go's `internal` boundary.

## Run

Requires Go 1.27+ and PostgreSQL. From this directory:

```sh
DATABASE_URL='postgres://user:password@localhost:5432/modura?sslmode=disable' go run ./cmd/registry-api
```

The service applies migrations on startup and listens on port `8081` by default. See
the command documentation and the repository's deployment guide for configuration.

## Install a version

The module is published from the `apps/registry-go` subdirectory of
[`tonidy/modura-platform`](https://github.com/tonidy/modura-platform). Go module tags
for this subdirectory use the prefix `apps/registry-go/`, for example:

```sh
go install github.com/tonidy/modura-platform/apps/registry-go/cmd/registry-api@v0.1.0
```

This installs the server binary; it does not deploy or configure the service/database.
