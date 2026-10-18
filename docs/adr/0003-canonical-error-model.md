# ADR-0003: Canonical error model

Status: Accepted (M2). The MCP mapping was added in M5.

## Context

HTTP, the SDK, the CLI and MCP must report the same failure the same way. Without one model, every handler picks its own status codes and messages, and clients end up matching on strings.

## Decision

Every error response has the same wire shape, defined in `@modura/runtime-contracts`:

```json
{
  "code": "sales.INSUFFICIENT_STOCK",
  "message": "Butter Croissant has 1 available, 2 requested. Nothing was sold.",
  "retryable": false,
  "operation": "sales.createSale",
  "requestId": "req_1b3bb64f593f9015",
  "details": { "lines": [{ "productId": "prd_croissant", "requested": 2, "available": 1 }] }
}
```

- Clients match on `code`, never on `message`.
- Every error belongs to one category, and the category alone decides the HTTP status:

  | Category | HTTP |
  |---|---|
  | validation | 400 |
  | unauthenticated | 401 |
  | forbidden | 403 |
  | not_found | 404 |
  | conflict | 409 |
  | unprocessable | 422 |
  | rate_limited | 429 |
  | internal | 500 |
  | unavailable | 503 |

- Platform errors (`VALIDATION_FAILED`, `FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`, ...) are unqualified and owned by the platform.
- Domain errors are qualified (`inventory.PRODUCT_NOT_FOUND`) and declared by their module with a category and a `retryable` flag.
- The IR lists, for every operation, every code it can return: its declared domain errors plus platform errors implied by its traits.
- `INTERNAL` never leaks details. They go to logs, keyed by `requestId`.
- OpenAPI declares one response per status an operation can return, and lists the codes for that status in `x-modura-error-codes`.
- The SDK returns a `Result` instead of throwing. Each operation has its own code union (`SalesCreateSaleErrorCode`), so an exhaustive `switch` in the UI stops compiling when the contract adds a code.
- The Go service keeps a table of the codes it emits. A test compares it with the IR, so the server cannot invent a code or change a category on its own.
- MCP (decided in M5, ADR-0009): errors come back as MCP tool errors (`isError: true`) whose text is the same canonical error JSON, not a flattened message.

## Evidence

- `apps/sales-go/internal/httpapi/contract_test.go`: every real response is validated against OpenAPI, including that an error code is listed for its status. `TestErrorCatalogMatchesIR` checks the Go table.
- `packages/pos-sdk/fixtures/consumer.ts`: exhaustive handling of `SalesCreateSaleErrorCode`.
- `apps/sales-go/internal/httpapi/checkout_test.go` and `contract_test.go`: every `sales.createSale` code except `RATE_LIMITED` (M3) and `UNAVAILABLE` is produced by a real request and validated against its declared status. `UNAUTHENTICATED` is exercised on `inventory.getStock`, through the same middleware.
