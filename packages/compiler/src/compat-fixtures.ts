import { defineModule, defineType, t, type ModuleDefinition, type OperationDefinition } from '@modura/schema';
import { canonicalJson } from './canonical-json.ts';
import { checkCompatibility, type Change } from './compat.ts';
import { compile } from './compile.ts';
import type { IrDocument } from './ir.ts';

/**
 * Shared compatibility fixtures (plan M5). Each case is a pair of IR documents plus
 * the report the TypeScript checker produces for them. The Go port in
 * apps/registry-go/internal/compat must produce exactly the same report, so the two
 * implementations cannot drift. Together the cases cover every rule in ADR-0002.
 *
 * tests/compat-fixtures/fixtures.jsonl is written from these cases; a test fails if
 * the file is stale. Regenerate with UPDATE_FIXTURES=1 pnpm --filter @modura/compiler test.
 */

export interface CompatFixture {
  readonly name: string;
  readonly previous: IrDocument;
  readonly next: IrDocument;
  readonly changes: readonly Change[];
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
}

const Label = defineType('shop.Label', t.string({ maxLength: 40 }));

const basePayload = {
  id: t.string(),
  quantity: t.integer({ minimum: 1 }),
};

const baseInput = {
  id: t.string({ pattern: '^itm_[a-z]+$' }),
  note: t.optional(t.string({ maxLength: 50 })),
  quantity: t.integer({ minimum: 1, maximum: 10 }),
  mode: t.enum(['fast', 'slow']),
  meta: t.optional(t.json()),
};

const baseOutput = {
  id: t.string(),
  status: t.enum(['open', 'closed']),
  count: t.integer({ minimum: 0 }),
  items: t.array(t.string(), { maxItems: 5 }),
  label: t.optional(Label),
  payload: t.json(),
};

const baseOperation: OperationDefinition = {
  kind: 'query',
  description: 'Get an item.',
  requires: ['shop.read'],
  input: t.object(baseInput),
  output: t.object(baseOutput),
  errors: ['GONE'],
  expose: { mcp: true },
};

function shop(
  options: {
    version?: string;
    operation?: Partial<OperationDefinition>;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    extraOperations?: Record<string, OperationDefinition>;
    /** Overrides for the itemSold payload, or `null` to drop the event. */
    payload?: Record<string, unknown> | null;
    extraEvents?: boolean;
  } = {},
): ModuleDefinition {
  const events =
    options.payload === null
      ? {}
      : {
          itemSold: {
            description: 'An item was sold.',
            payload: t.object(withOverrides(basePayload, options.payload ?? {})),
          },
          ...(options.extraEvents
            ? { itemReturned: { description: 'An item came back.', payload: t.object({ id: t.string() }) } }
            : {}),
        };
  const operation: OperationDefinition = {
    ...baseOperation,
    ...(options.input ? { input: t.object(withOverrides(baseInput, options.input)) } : {}),
    ...(options.output ? { output: t.object(withOverrides(baseOutput, options.output)) } : {}),
    ...options.operation,
  };
  return defineModule({
    name: 'shop',
    version: options.version ?? '1.0.0',
    description: 'Fixture shop.',
    permissions: { read: 'Read.', admin: 'Administer.' },
    errors: {
      GONE: { category: 'not_found', retryable: false, description: 'Gone.' },
      BUSY: { category: 'unavailable', retryable: true, description: 'Busy.' },
    },
    operations: { getItem: operation, ...options.extraOperations },
    events,
  });
}

function ledger(subscribes: string[]): ModuleDefinition {
  return defineModule({
    name: 'ledger',
    version: '1.0.0',
    description: 'Fixture ledger that reacts to shop events.',
    permissions: { read: 'Read.' },
    operations: {
      balance: {
        kind: 'query',
        description: 'Current balance.',
        requires: ['ledger.read'],
        input: t.object({}),
        output: t.object({ amount: t.money() }),
      },
    },
    subscribes,
  });
}

/** Overrides replace a field; `undefined` removes it. */
function withOverrides(base: Record<string, any>, overrides: Record<string, unknown>) {
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

const auditModule = defineModule({
  name: 'audit',
  version: '0.3.0',
  description: 'Fixture audit log.',
  permissions: { read: 'Read.' },
  operations: {
    listEntries: {
      kind: 'query',
      description: 'List entries.',
      requires: ['audit.read'],
      input: t.object({}),
      output: t.object({ entries: t.array(t.string()) }),
    },
  },
});

const pingOperation: OperationDefinition = {
  kind: 'query',
  description: 'Ping.',
  requires: ['shop.read'],
  input: t.object({}),
  output: t.boolean(),
};

type Case = readonly [name: string, previous: ModuleDefinition[], next: ModuleDefinition[]];

function cases(): Case[] {
  const base = [shop()];
  return [
    ['identical', base, [shop()]],

    // Inputs: rejecting a request that used to be valid is breaking.
    ['input field removed', base, [shop({ input: { note: undefined } })]],
    ['input required field added', base, [shop({ input: { code: t.string() } })]],
    ['input optional field added', base, [shop({ input: { code: t.optional(t.string()) } })]],
    ['input optional field became required', base, [shop({ input: { note: t.string({ maxLength: 50 }) } })]],
    ['input required field became optional', base, [shop({ input: { quantity: t.optional(t.integer({ minimum: 1, maximum: 10 })) } })]],
    ['input bound narrowed', base, [shop({ input: { note: t.optional(t.string({ maxLength: 20 })) } })]],
    ['input bound widened', base, [shop({ input: { quantity: t.integer({ minimum: 1, maximum: 99 }) } })]],
    ['input bound removed', base, [shop({ input: { quantity: t.integer({ minimum: 1 }) } })]],
    ['input enum value added', base, [shop({ input: { mode: t.enum(['fast', 'slow', 'eco']) } })]],
    ['input enum value removed', base, [shop({ input: { mode: t.enum(['fast']) } })]],
    ['input pattern changed', base, [shop({ input: { id: t.string({ pattern: '^itm_[a-z0-9]+$' }) } })]],
    ['input type changed', base, [shop({ input: { quantity: t.string() } })]],

    // Outputs: anything a client may not be ready to receive is breaking.
    ['output field removed', base, [shop({ output: { count: undefined } })]],
    ['output field added', base, [shop({ output: { extra: t.boolean() } })]],
    ['output optional field became required', base, [shop({ output: { label: Label } })]],
    ['output required field became optional', base, [shop({ output: { count: t.optional(t.integer({ minimum: 0 })) } })]],
    ['output bound narrowed', base, [shop({ output: { count: t.integer({ minimum: 1 }) } })]],
    ['output bound widened', base, [shop({ output: { items: t.array(t.string(), { maxItems: 50 }) } })]],
    ['output enum value added', base, [shop({ output: { status: t.enum(['open', 'closed', 'archived']) } })]],
    ['output enum value removed', base, [shop({ output: { status: t.enum(['open']) } })]],
    ['output type changed to json', base, [shop({ output: { id: t.json() } })]],
    ['output change through a named type', base, [shop({ output: { label: t.optional(defineType('shop.Label', t.string({ maxLength: 80 }))) } })]],

    // Operations and modules.
    ['operation added', base, [shop({ extraOperations: { ping: pingOperation } })]],
    ['operation removed', [shop({ extraOperations: { ping: pingOperation } })], base],
    ['module added', base, [shop(), auditModule]],
    ['module removed', [shop(), auditModule], base],
    ['kind changed', base, [shop({ operation: { kind: 'command', expose: {} } })]],
    ['permission added', base, [shop({ operation: { requires: ['shop.read', 'shop.admin'] } })]],
    ['permission removed', [shop({ operation: { requires: ['shop.read', 'shop.admin'] } })], base],
    ['became idempotent', [shop({ operation: { kind: 'command', expose: {} } })], [shop({ operation: { kind: 'command', expose: {}, idempotent: true } })]],
    ['no longer idempotent', [shop({ operation: { kind: 'command', expose: {}, idempotent: true } })], [shop({ operation: { kind: 'command', expose: {} } })]],
    ['error code added', base, [shop({ operation: { errors: ['GONE', 'BUSY'] } })]],
    ['mcp exposure removed', base, [shop({ operation: { expose: {} } })]],

    // Source-breaking: the wire is unchanged, generated type names are not.
    ['named type renamed', base, [shop({ output: { label: t.optional(defineType('shop.Tag', t.string({ maxLength: 40 }))) } })]],
    ['named type inlined', base, [shop({ output: { label: t.optional(t.string({ maxLength: 40 })) } })]],
    ['inline type given a name', base, [shop({ output: { count: defineType('shop.Count', t.integer({ minimum: 0 })) } })]],
    ['source-breaking with a major bump', base, [shop({ version: '2.0.0', output: { label: t.optional(t.string({ maxLength: 40 })) } })]],

    // Events: consumers receive payloads, so they compare like outputs.
    ['event added', base, [shop({ extraEvents: true })]],
    ['event removed', [shop({ extraEvents: true })], base],
    ['event payload field added', base, [shop({ payload: { note: t.optional(t.string()) } })]],
    ['event payload field removed', base, [shop({ payload: { quantity: undefined } })]],
    ['event payload bound widened', base, [shop({ payload: { quantity: t.integer({ minimum: 0 }) } })]],
    ['subscription added', [shop(), ledger([])], [shop(), ledger(['shop.itemSold'])]],
    ['subscription removed', [shop(), ledger(['shop.itemSold'])], [shop(), ledger([])]],

    // Version rules.
    ['breaking with a major bump', base, [shop({ version: '2.0.0', output: { count: undefined } })]],
    ['breaking with a minor bump at 1.x', base, [shop({ version: '1.1.0', output: { count: undefined } })]],
    ['breaking with a minor bump while 0.x', [shop({ version: '0.4.2' })], [shop({ version: '0.5.0', output: { count: undefined } })]],
    ['breaking with a patch bump while 0.x', [shop({ version: '0.4.2' })], [shop({ version: '0.4.3', output: { count: undefined } })]],
    ['compatible change with a minor bump', base, [shop({ version: '1.1.0', output: { extra: t.boolean() } })]],
    ['compatible change with only a patch bump', base, [shop({ version: '1.0.1', output: { extra: t.boolean() } })]],
    ['version went down', base, [shop({ version: '0.9.0' })]],
    ['version went down with a breaking change', base, [shop({ version: '0.9.0', output: { count: undefined } })]],
  ];
}

/**
 * Serializes through canonical JSON, exactly as a published IR document would be.
 * platformErrors is emptied because the compatibility check never reads it, and it
 * would otherwise be most of the fixture file.
 */
function canonical(modules: ModuleDefinition[]): IrDocument {
  const ir = JSON.parse(canonicalJson(compile(modules))) as IrDocument;
  return { ...ir, platformErrors: {} };
}

export function buildCompatFixtures(): CompatFixture[] {
  return cases().map(([name, previousModules, nextModules]) => {
    const previous = canonical(previousModules);
    const next = canonical(nextModules);
    const { changes, violations, warnings } = checkCompatibility(previous, next);
    return { name, previous, next, changes, violations, warnings };
  });
}
