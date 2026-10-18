import { defineModule, defineType, t, type ModuleDefinition } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import { compile, CompileError } from './compile.ts';

const ItemId = defineType('shop.ItemId', t.string({ pattern: '^itm_[a-z]+$' }));

const shop = defineModule({
  name: 'shop',
  version: '0.1.0',
  description: 'A test shop.',
  permissions: { read: 'Read items.', write: 'Buy items.' },
  errors: {
    OUT_OF_STOCK: { category: 'unprocessable', retryable: false, description: 'Not enough stock.' },
  },
  operations: {
    getItem: {
      kind: 'query',
      description: 'Get one item.',
      requires: ['shop.read'],
      input: t.object({ id: ItemId }),
      output: t.object({ id: ItemId, note: t.optional(t.string()) }),
      expose: { mcp: true },
    },
    buyItem: {
      kind: 'command',
      description: 'Buy an item.',
      requires: ['shop.write', 'shop.read', 'shop.write'],
      idempotent: true,
      input: t.object({ id: ItemId, quantity: t.integer({ minimum: 1 }) }),
      output: t.object({ id: ItemId }),
      errors: ['OUT_OF_STOCK'],
    },
  },
});

function reversed<V>(record: Readonly<Record<string, V>>): Record<string, V> {
  return Object.fromEntries(Object.entries(record).reverse());
}

function compileIssues(modules: ModuleDefinition[]): string[] {
  try {
    compile(modules);
  } catch (error) {
    if (error instanceof CompileError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  throw new Error('expected compilation to fail');
}

describe('compile', () => {
  it('stores a named type once and references it everywhere', () => {
    const ir = compile([shop]);

    expect(ir.types['shop.ItemId']).toEqual({ kind: 'string', pattern: '^itm_[a-z]+$' });
    expect(ir.modules.shop?.operations.getItem?.input.fields.id).toEqual({
      required: true,
      type: { kind: 'ref', name: 'shop.ItemId' },
    });
  });

  it('marks optional fields as not required', () => {
    const output = compile([shop]).modules.shop?.operations.getItem?.output;

    expect(output).toMatchObject({ fields: { note: { required: false } } });
  });

  it('applies trait defaults and sorts, dedupes and completes requires and errors', () => {
    const { getItem, buyItem } = compile([shop]).modules.shop!.operations;

    expect(buyItem?.requires).toEqual(['shop.read', 'shop.write']);
    expect(buyItem?.errors).toEqual([
      'FORBIDDEN',
      'IDEMPOTENCY_IN_PROGRESS',
      'IDEMPOTENCY_KEY_REUSED',
      'INTERNAL',
      'RATE_LIMITED',
      'UNAUTHENTICATED',
      'UNAVAILABLE',
      'VALIDATION_FAILED',
      'shop.OUT_OF_STOCK',
    ]);
    expect(buyItem?.expose).toEqual({ mcp: false });
    expect(getItem?.idempotent).toBe(false);
    expect(getItem?.errors).not.toContain('IDEMPOTENCY_KEY_REUSED');
  });

  it('produces byte-identical output when the source declares things in a different order', () => {
    const reordered = defineModule({
      ...shop,
      permissions: reversed(shop.permissions ?? {}),
      operations: reversed(shop.operations),
    });

    expect(canonicalJson(compile([reordered]))).toBe(canonicalJson(compile([shop])));
  });

  it('records cross-module dependencies through types, permissions and errors', () => {
    const orders = defineModule({
      name: 'orders',
      version: '0.1.0',
      description: 'Orders that point at shop items.',
      permissions: { read: 'Read orders.' },
      operations: {
        getOrder: {
          kind: 'query',
          description: 'Get an order.',
          requires: ['orders.read', 'shop.read'],
          input: t.object({ itemId: ItemId }),
          output: t.object({ itemId: ItemId }),
          errors: ['shop.OUT_OF_STOCK'],
        },
      },
    });

    const ir = compile([orders, shop]);

    expect(ir.modules.orders?.dependencies).toEqual(['shop']);
    expect(ir.modules.shop?.dependencies).toEqual([]);
  });

  it('reports every rule violation in one run', () => {
    const broken = defineModule({
      name: 'broken',
      version: '1.0',
      description: 'Breaks the rules.',
      permissions: { read: 'Read.' },
      operations: {
        idempotentQuery: {
          kind: 'query',
          description: 'Not allowed.',
          requires: ['broken.read'],
          idempotent: true,
          input: t.object({}),
          output: t.boolean(),
        },
        exposedCommand: {
          kind: 'command',
          description: 'Not allowed on MCP.',
          requires: ['broken.read'],
          input: t.object({}),
          output: t.boolean(),
          expose: { mcp: true },
        },
        unguarded: {
          kind: 'query',
          description: 'No permission and unknown references.',
          requires: [],
          input: t.object({ q: t.string({ pattern: '^(?=a)a$' }) }),
          output: t.boolean(),
          errors: ['NOPE'],
        },
      },
    });

    expect(compileIssues([broken])).toEqual([
      'broken.version: "1.0" is not a MAJOR.MINOR.PATCH version',
      'broken.idempotentQuery: only commands can be idempotent; queries are already safe to retry',
      'broken.exposedCommand: v1 exposes only queries to MCP; commands stay off AI surfaces',
      'broken.unguarded.requires: operations must require at least one permission',
      'broken.unguarded.errors: unknown error "broken.NOPE"',
      `broken.unguarded.input.q: pattern "^(?=a)a$" uses lookaround or backreferences, which Go's RE2 engine cannot run`,
    ]);
  });

  it('rejects two different types that share a name', () => {
    const Clash = defineType('shop.ItemId', t.integer());
    const other = defineModule({
      ...shop,
      operations: {
        clash: {
          kind: 'query',
          description: 'Uses the clashing type.',
          requires: ['shop.read'],
          input: t.object({ id: Clash }),
          output: t.boolean(),
        },
        ...shop.operations,
      },
    });

    expect(compileIssues([other])).toEqual([
      'shop.getItem.input.id: type "shop.ItemId" is defined twice with different shapes',
      'shop.getItem.output.id: type "shop.ItemId" is defined twice with different shapes',
      'shop.buyItem.input.id: type "shop.ItemId" is defined twice with different shapes',
      'shop.buyItem.output.id: type "shop.ItemId" is defined twice with different shapes',
    ]);
  });
});
