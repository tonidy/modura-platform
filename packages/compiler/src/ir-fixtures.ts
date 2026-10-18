import { defineModule, defineType, t, type ModuleDefinition } from '@modura/schema';
import { canonicalJson } from './canonical-json.ts';
import { compile } from './compile.ts';
import type { IrDocument } from './ir.ts';

/**
 * Shared IR fixtures (plan M6). Valid documents both validators must accept and
 * invalid ones both must reject: TypeScript with validateIr, Go with ir.Parse plus
 * ir.IsPublishable. Written to tests/ir-fixtures by the test in ir-fixtures.test.ts.
 */

type Json = Record<string, any>;

const Sku = defineType('shop.Sku', t.string({ pattern: '^[A-Z]{3}-[0-9]{3}$', minLength: 7, maxLength: 7 }));
const Item = defineType(
  'shop.Item',
  t.object({
    sku: Sku,
    name: t.string({ minLength: 1 }),
    price: t.money(),
    tags: t.array(t.enum(['new', 'on_sale']), { maxItems: 3 }),
    stock: t.integer({ minimum: 0, maximum: 1000 }),
    active: t.boolean(),
    updatedAt: t.timestamp(),
    extra: t.optional(t.json()),
  }),
);

const shop = defineModule({
  name: 'shop',
  version: '1.2.0',
  description: 'A shop using every type kind.',
  permissions: { read: 'Read items.', write: 'Sell items.' },
  errors: { SOLD_OUT: { category: 'unprocessable', retryable: false, description: 'Nothing left.' } },
  operations: {
    getItem: {
      kind: 'query',
      description: 'Get one item.',
      requires: ['shop.read'],
      input: t.object({ sku: Sku }),
      output: Item,
      expose: { mcp: true },
    },
    sell: {
      kind: 'command',
      description: 'Sell an item.',
      requires: ['shop.write'],
      idempotent: true,
      input: t.object({ sku: Sku, quantity: t.integer({ minimum: 1 }) }),
      output: t.object({ item: Item }),
      errors: ['SOLD_OUT'],
    },
  },
  events: {
    itemSold: { description: 'An item was sold.', payload: t.object({ sku: Sku, quantity: t.integer({ minimum: 1 }) }) },
  },
});

const ledger = defineModule({
  name: 'ledger',
  version: '0.1.0',
  description: 'Reacts to sales.',
  permissions: { read: 'Read.' },
  operations: {
    balance: {
      kind: 'query',
      description: 'Balance.',
      requires: ['ledger.read'],
      input: t.object({}),
      output: t.object({ amount: t.money() }),
    },
  },
  subscribes: ['shop.itemSold'],
});

const tiny = defineModule({
  name: 'tiny',
  version: '1.0.0',
  description: 'Smallest useful module.',
  permissions: { read: 'Read.' },
  operations: {
    ping: { kind: 'query', description: 'Ping.', requires: ['tiny.read'], input: t.object({}), output: t.boolean() },
  },
});

const awkwardText = 'Quotes " and \\ backslash, <b>&amp;</b>, tab\t, newline\n, \u0001, é, 😀,   and  .';
const escaping = defineModule({
  ...tiny,
  description: awkwardText,
  permissions: { read: awkwardText },
});

function build(modules: ModuleDefinition[]): Json {
  return JSON.parse(canonicalJson(compile(modules)));
}

function mutate(document: Json, change: (doc: Json) => void): Json {
  const copy = structuredClone(document);
  change(copy);
  return copy;
}

export interface IrFixtures {
  readonly valid: Readonly<Record<string, Json>>;
  readonly invalid: Readonly<Record<string, Json>>;
}

export function buildIrFixtures(): IrFixtures {
  const full = build([shop, ledger]);
  const shopOf = (doc: Json) => doc.modules.shop;
  const getItem = (doc: Json) => doc.modules.shop.operations.getItem;
  const itemFields = (doc: Json) => doc.types['shop.Item'].fields;

  return {
    valid: {
      minimal: build([tiny]),
      full,
      escaping: build([escaping]),
      'newer-minor-with-unknown-fields': mutate(full, (doc) => {
        doc.irVersion = '1.3.0';
        doc.futureTopLevel = { anything: [1, 2, 3] };
        shopOf(doc).owner = 'team-checkout';
        getItem(doc).deprecated = false;
        itemFields(doc).stock.type.unit = 'pieces';
      }),
    },
    invalid: {
      'unknown-field-in-1.0': mutate(full, (doc) => {
        shopOf(doc).owner = 'team-checkout';
      }),
      'unsupported-major-version': mutate(full, (doc) => {
        doc.irVersion = '2.0.0';
      }),
      'pre-1.0-version': mutate(full, (doc) => {
        doc.irVersion = '0.2.0';
      }),
      'missing-required-field': mutate(full, (doc) => {
        delete getItem(doc).expose;
      }),
      'no-modules': mutate(full, (doc) => {
        doc.modules = {};
      }),
      'dangling-reference': mutate(full, (doc) => {
        delete doc.types['shop.Sku'];
      }),
      'reference-cycle': mutate(full, (doc) => {
        itemFields(doc).similar = { required: false, type: { kind: 'ref', name: 'shop.Item' } };
      }),
      'unknown-type-kind': mutate(full, (doc) => {
        itemFields(doc).stock.type = { kind: 'decimal' };
      }),
      'non-ascii-field-name': mutate(full, (doc) => {
        itemFields(doc)['café'] = { required: false, type: { kind: 'boolean' } };
      }),
      'enum-value-not-snake-case': mutate(full, (doc) => {
        itemFields(doc).tags.type.items.values = ['new', 'On Sale'];
      }),
      'non-integer-bound': mutate(full, (doc) => {
        itemFields(doc).stock.type.maximum = 10.5;
      }),
      'bad-error-category': mutate(full, (doc) => {
        shopOf(doc).errors.SOLD_OUT.category = 'teapot';
      }),
      'undeclared-permission': mutate(full, (doc) => {
        getItem(doc).requires = ['shop.admin'];
      }),
      'no-required-permission': mutate(full, (doc) => {
        getItem(doc).requires = [];
      }),
      'undeclared-error': mutate(full, (doc) => {
        getItem(doc).errors.push('shop.NOPE');
      }),
      'non-object-input': mutate(full, (doc) => {
        getItem(doc).input = { kind: 'string' };
      }),
      'non-object-event-payload': mutate(full, (doc) => {
        shopOf(doc).events.itemSold.payload = { kind: 'integer' };
      }),
      'unknown-subscription': mutate(full, (doc) => {
        doc.modules.ledger.subscribes = ['shop.itemReturned'];
      }),
      'self-subscription': mutate(full, (doc) => {
        shopOf(doc).subscribes = ['shop.itemSold'];
      }),
    },
  };
}

export type { IrDocument };
