import type { ErrorCategory } from '@modura/runtime-contracts';
import type {
  BooleanType,
  EnumType,
  IntegerType,
  JsonType,
  MoneyType,
  StringType,
  TimestampType,
} from '@modura/schema';

/**
 * Version of the IR format itself, independent of any module's contract version.
 * 0.2.0 added the `json` type kind; 1.0.0 added events and froze the format
 * (docs/spec/ir-1.0.md, docs/stability.md).
 */
export const IR_VERSION = '1.0.0';

export interface IrDocument {
  readonly irVersion: string;
  readonly modules: Readonly<Record<string, IrModule>>;
  /** Named types keyed by qualified name, for example "catalog.ProductId". */
  readonly types: Readonly<Record<string, IrType>>;
  /** Copied in so consumers in other languages need nothing but this document. */
  readonly platformErrors: Readonly<Record<string, IrError>>;
}

export interface IrModule {
  readonly version: string;
  readonly description: string;
  /** Other modules whose types, permissions, errors or events this module uses. */
  readonly dependencies: readonly string[];
  readonly permissions: Readonly<Record<string, { readonly description: string }>>;
  readonly errors: Readonly<Record<string, IrError>>;
  readonly operations: Readonly<Record<string, IrOperation>>;
  /** Events this module publishes, keyed by unqualified name. */
  readonly events: Readonly<Record<string, IrEvent>>;
  /** Qualified events of other modules this module consumes, sorted. */
  readonly subscribes: readonly string[];
}

export interface IrEvent {
  readonly description: string;
  /** An object type, or a reference to a named object type. */
  readonly payload: IrType;
}

export interface IrError {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly description: string;
}

/** Every trait is explicit with defaults already applied, so generators never apply their own. */
export interface IrOperation {
  readonly kind: 'query' | 'command';
  readonly description: string;
  readonly requires: readonly string[];
  readonly idempotent: boolean;
  readonly input: IrObjectType;
  readonly output: IrType;
  /** Every error the operation can return: qualified domain codes plus implied platform codes. */
  readonly errors: readonly string[];
  readonly expose: { readonly mcp: boolean };
}

export interface IrArrayType {
  readonly kind: 'array';
  readonly description?: string;
  readonly items: IrType;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface IrField {
  readonly required: boolean;
  readonly type: IrType;
}

export interface IrObjectType {
  readonly kind: 'object';
  readonly description?: string;
  readonly fields: Readonly<Record<string, IrField>>;
}

export interface IrRefType {
  readonly kind: 'ref';
  readonly name: string;
}

export type IrType =
  | StringType
  | IntegerType
  | BooleanType
  | TimestampType
  | MoneyType
  | JsonType
  | EnumType
  | IrArrayType
  | IrObjectType
  | IrRefType;
