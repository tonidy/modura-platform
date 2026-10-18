# Modura DSL guide

For DSL 1.0 (engine `1.0.0-rc.1`, IR format `1.0.0`). The IR itself is specified in [ir-1.0.md](ir-1.0.md); what is promised across versions is in [docs/stability.md](../stability.md).

## 1. Pipeline

```text
modules/*/src/index.ts  (TypeScript DSL, @modura/schema)
        |
        v
@modura/compiler        validate, apply defaults, resolve references, check generated names
        |
        v
generated/ir/modura.ir.json   (canonical JSON, checked in)
        |
        v
generators              OpenAPI, TypeScript SDK, MCP tool definitions
        |
        v
oapi-codegen            Go types and strict handler interface, from the OpenAPI output
```

Generators read only the IR. They never import the DSL. `pnpm generate` runs the whole chain; `pnpm generate --strict` also fails on warnings.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| Module | A versioned group of operations, events, permissions, errors and named types, for example `inventory`. |
| Operation | A business action with a stable qualified name (`inventory.getStock`), typed input and output, required permissions and possible errors. |
| Query / command | A query reads state. A command changes it. Only commands can be idempotent, and only queries can be exposed to MCP. |
| Event | Something that happened in a module (`sales.saleCompleted`), with an object payload, for other modules to react to. |
| Subscription | A module's declaration that it consumes another module's event. It makes the dependency visible in the IR. |
| Permission | A capability an identity must hold, declared by a module and referenced as `module.name` (`sales.write`). Every operation requires at least one. |
| Domain error | A business failure declared by a module, referenced as `module.CODE` (`sales.INSUFFICIENT_STOCK`). |
| Platform error | A failure owned by the platform (`FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`). Modules never declare these; the compiler attaches them from traits. |
| Named type | A type with a qualified name (`catalog.ProductId`), stored once in the IR and referenced elsewhere. |
| Trait | Operation metadata that changes behavior across surfaces: `kind`, `idempotent`, `requires`, `expose`. |

## 3. Example

```ts
import { ProductId } from '@modura/module-catalog';
import { defineModule, defineType, t } from '@modura/schema';

const StockLevel = defineType('inventory.StockLevel', t.object({
  productId: ProductId,
  available: t.integer({ minimum: 0 }),
}));

export const inventory = defineModule({
  name: 'inventory',
  version: '1.0.0',
  description: 'Authoritative stock levels for sellable products.',
  permissions: { read: 'Read stock levels.' },
  errors: {
    PRODUCT_NOT_FOUND: { category: 'not_found', retryable: false, description: '...' },
  },
  operations: {
    getStock: {
      kind: 'query',
      description: 'Return the authoritative available stock for one product.',
      requires: ['inventory.read'],
      input: t.object({ productId: ProductId }),
      output: StockLevel,
      errors: ['PRODUCT_NOT_FOUND'],
      expose: { mcp: true },
    },
  },
  events: {
    stockChanged: { description: 'Available stock changed.', payload: StockLevel },
  },
  subscribes: ['sales.saleCompleted'],
});
```

## 4. Types

| DSL | IR `kind` | Notes |
|---|---|---|
| `t.string({ minLength, maxLength, pattern })` | `string` | Patterns must be RE2-compatible so Go can enforce them. |
| `t.integer({ minimum, maximum })` | `integer` | Safe-integer range only. There is no float type. |
| `t.boolean()` | `boolean` | |
| `t.timestamp()` | `timestamp` | RFC 3339 string in UTC. |
| `t.money()` | `money` | `{ amountMinor: integer, currency: "USD" }`. See ADR-0006. |
| `t.json()` | `json` | Any JSON value, unchecked. A last resort; the provider must validate it. See ADR-0007. |
| `t.enum(values)` | `enum` | Values are lower snake case. Authored order is kept. |
| `t.array(items, { minItems, maxItems })` | `array` | |
| `t.object(fields)` with `t.optional(type)` | `object` | Each field becomes `{ required, type }`. |
| `defineType('module.Name', type)` | `ref` | Body stored in the IR's top-level `types`. |

Every type accepts `description`.

## 5. Compiler rules

The compiler collects every issue before failing, so one run shows all problems.

Errors:

- Module, operation, permission, event and field names are lowerCamelCase. Error codes are UPPER_SNAKE_CASE. Type names are `module.PascalCase`. Enum values are lower snake case.
- Module versions are `MAJOR.MINOR.PATCH`.
- Modules, operations and events need a non-empty description, because docs and MCP tools reuse it.
- Every operation requires at least one permission, and every permission it names must be declared.
- Only commands can be idempotent. Only queries can be exposed to MCP.
- Every referenced error must be declared. Unqualified names refer to the owning module.
- Operation input must be `t.object(...)`. Event payloads must be objects, inline or named.
- Subscriptions must name an event of another module.
- A named type can only have one shape.
- Ranges must be safe integers, non-negative where it matters, and `min <= max`. Enums need at least one value and no duplicates. Patterns must compile and must not use lookaround or backreferences.
- Contract names must not collide once a generator transforms them. For example, module `shop` with operation `getOrder` and module `shopGet` with operation `order` both become `ShopGetOrder`. Names reserved by generated code (`Money`, `JsonValue`, `Result`, `Transport`, `Error` and a few more) are rejected too. The full list is `RESERVED_IDENTIFIERS` in `@modura/compiler`.

Warnings (fail only with `--strict`):

- A permission no operation requires.
- A domain error no operation can return.

## 6. Compatibility

Comparing two IR versions is a separate check: every change is `breaking`, `source` or `safe`, and `breaking` and `source` changes need a version bump. See ADR-0002 for the rules table and ADR-0010 for severities and version rules.
