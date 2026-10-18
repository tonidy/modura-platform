/**
 * Modura DSL v0.2: the TypeScript authoring surface for module contracts.
 *
 * Everything here is plain data. The compiler (@modura/compiler) validates it and
 * lowers it to the canonical JSON IR, which is the only input generators read.
 * See docs/spec/dsl.md.
 */
import type { ErrorDefinition } from '@modura/runtime-contracts';

export type { ErrorDefinition } from '@modura/runtime-contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StringType {
  readonly kind: 'string';
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Must be RE2-compatible (no lookaround or backreferences) so Go can enforce it too. */
  readonly pattern?: string;
}

/** A whole number within the JavaScript safe-integer range. There is no float type. */
export interface IntegerType {
  readonly kind: 'integer';
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanType {
  readonly kind: 'boolean';
  readonly description?: string;
}

/** An RFC 3339 timestamp in UTC, serialized as a string. */
export interface TimestampType {
  readonly kind: 'timestamp';
  readonly description?: string;
}

/** `{ amountMinor: integer, currency: ISO 4217 code }`. See docs/adr/0006-money.md. */
export interface MoneyType {
  readonly kind: 'money';
  readonly description?: string;
}

/**
 * Any JSON value, passed through unchecked. For payloads the contract does not own,
 * such as a whole IR document in the registry. Prefer a real type whenever one fits.
 * See docs/adr/0007-dsl-json-type.md.
 */
export interface JsonType {
  readonly kind: 'json';
  readonly description?: string;
}

export interface EnumType {
  readonly kind: 'enum';
  readonly description?: string;
  /**
   * Lower snake case (`^[a-z][a-z0-9_]*$`), so every generator can turn a value into
   * an identifier. Order is kept as authored, since it can carry display meaning.
   */
  readonly values: readonly string[];
}

export interface ArrayType {
  readonly kind: 'array';
  readonly description?: string;
  readonly items: TypeNode;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface Field {
  readonly type: TypeNode;
  readonly optional: boolean;
}

export interface ObjectType {
  readonly kind: 'object';
  readonly description?: string;
  readonly fields: Readonly<Record<string, Field>>;
}

/**
 * A type with a qualified name such as "catalog.ProductId". The IR stores it once
 * under `types` and replaces every use with a reference, which also records the
 * dependency between modules.
 */
export interface NamedType {
  readonly kind: 'named';
  readonly name: string;
  readonly type: TypeNode;
}

export type TypeNode =
  | StringType
  | IntegerType
  | BooleanType
  | TimestampType
  | MoneyType
  | JsonType
  | EnumType
  | ArrayType
  | ObjectType
  | NamedType;

interface OptionalField {
  readonly optional: true;
  readonly type: TypeNode;
}

type Options<T> = Omit<T, 'kind'>;

export const t = {
  string: (options: Options<StringType> = {}): StringType => ({ kind: 'string', ...options }),
  integer: (options: Options<IntegerType> = {}): IntegerType => ({ kind: 'integer', ...options }),
  boolean: (options: Options<BooleanType> = {}): BooleanType => ({ kind: 'boolean', ...options }),
  timestamp: (options: Options<TimestampType> = {}): TimestampType => ({
    kind: 'timestamp',
    ...options,
  }),
  money: (options: Options<MoneyType> = {}): MoneyType => ({ kind: 'money', ...options }),
  json: (options: Options<JsonType> = {}): JsonType => ({ kind: 'json', ...options }),
  enum: (values: readonly string[], options: Omit<Options<EnumType>, 'values'> = {}): EnumType => ({
    kind: 'enum',
    values,
    ...options,
  }),
  array: (items: TypeNode, options: Omit<Options<ArrayType>, 'items'> = {}): ArrayType => ({
    kind: 'array',
    items,
    ...options,
  }),
  object: (
    fields: Readonly<Record<string, TypeNode | OptionalField>>,
    options: Omit<Options<ObjectType>, 'fields'> = {},
  ): ObjectType => ({
    kind: 'object',
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        'kind' in field ? { type: field, optional: false } : field,
      ]),
    ),
    ...options,
  }),
  /** Marks an object field as optional. Only valid inside `t.object`. */
  optional: (type: TypeNode): OptionalField => ({ optional: true, type }),
};

export function defineType(name: string, type: TypeNode): NamedType {
  return { kind: 'named', name, type };
}

// ---------------------------------------------------------------------------
// Operations and modules
// ---------------------------------------------------------------------------

export interface OperationDefinition {
  /** A `query` reads state. A `command` changes it. */
  readonly kind: 'query' | 'command';
  readonly description: string;
  /** Qualified permissions the caller must hold, for example "inventory.read". At least one. */
  readonly requires: readonly string[];
  /**
   * The caller supplies an idempotency key and may retry safely. Commands only.
   * Generators decide the transport (an `Idempotency-Key` header for HTTP).
   */
  readonly idempotent?: boolean;
  readonly input: ObjectType;
  readonly output: TypeNode;
  /** Domain errors this operation may return. Unqualified names refer to the owning module. */
  readonly errors?: readonly string[];
  /** Extra surfaces beyond HTTP and the SDK. In v1 only queries may be exposed to MCP. */
  readonly expose?: { readonly mcp?: boolean };
}

/**
 * Something that happened in a module, published for other modules to react to.
 * Consumers must ignore payload fields they do not know, which is what makes adding
 * a field safe (docs/stability.md).
 */
export interface EventDefinition {
  readonly description: string;
  /** An object, inline or named. */
  readonly payload: ObjectType | NamedType;
}

export interface ModuleDefinition {
  readonly name: string;
  /** Semantic version of this module's contract. */
  readonly version: string;
  readonly description: string;
  /** Unqualified permission name to description. "read" in module "inventory" is "inventory.read". */
  readonly permissions?: Readonly<Record<string, string>>;
  /** Unqualified error code to definition. "PRODUCT_NOT_FOUND" in "inventory" is "inventory.PRODUCT_NOT_FOUND". */
  readonly errors?: Readonly<Record<string, ErrorDefinition>>;
  readonly operations: Readonly<Record<string, OperationDefinition>>;
  /** Events this module publishes. "saleCompleted" in "sales" is "sales.saleCompleted". */
  readonly events?: Readonly<Record<string, EventDefinition>>;
  /** Qualified events of other modules this module consumes, for example "sales.saleCompleted". */
  readonly subscribes?: readonly string[];
}

/** Identity helper that gives module literals full type checking and editor completion. */
export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return definition;
}
