import { defineModule, defineType, t, type ModuleDefinition } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { compile, CompileError, compileWithWarnings } from './compile.ts';

// Compiler rules added for schema engine 1.0 (plan M6, ADR-0010).

const Order = defineType('shop.Order', t.object({ id: t.string(), total: t.money() }));

function shop(extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return defineModule({
    name: 'shop',
    version: '1.0.0',
    description: 'Shop.',
    permissions: { read: 'Read.' },
    operations: {
      getOrder: {
        kind: 'query',
        description: 'Get an order.',
        requires: ['shop.read'],
        input: t.object({ id: t.string() }),
        output: Order,
      },
    },
    ...extra,
  });
}

function issues(modules: ModuleDefinition[]): string[] {
  try {
    compile(modules);
  } catch (error) {
    if (error instanceof CompileError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  throw new Error('expected compilation to fail');
}

describe('events', () => {
  it('lowers events and subscriptions, and records the dependency', () => {
    const ledger = defineModule({
      name: 'ledger',
      version: '1.0.0',
      description: 'Ledger.',
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
      subscribes: ['shop.orderPlaced'],
    });
    const ir = compile([shop({ events: { orderPlaced: { description: 'An order was placed.', payload: Order } } }), ledger]);

    expect(ir.modules.shop?.events).toEqual({
      orderPlaced: { description: 'An order was placed.', payload: { kind: 'ref', name: 'shop.Order' } },
    });
    expect(ir.modules.ledger?.subscribes).toEqual(['shop.orderPlaced']);
    expect(ir.modules.ledger?.dependencies).toEqual(['shop']);
    expect(ir.modules.shop?.subscribes).toEqual([]);
  });

  it('rejects non-object payloads, unknown subscriptions and self-subscriptions', () => {
    const broken = shop({
      events: {
        BadName: { description: 'Bad name.', payload: t.object({}) },
        counted: { description: 'Not an object.', payload: defineType('shop.Count', t.integer()) as never },
      },
      subscribes: ['shop.counted', 'nowhere.happened'],
    });

    expect(issues([broken])).toEqual([
      'shop.events.BadName: event names are lowerCamelCase',
      'shop.events.counted.payload: event payloads must be objects, inline or named',
      'shop.subscribes: "shop.counted" is this module\'s own event; modules only subscribe to others',
      'shop.subscribes: unknown event "nowhere.happened"',
    ]);
  });
});

describe('names in generated code', () => {
  it('rejects enum values generators cannot turn into identifiers', () => {
    const broken = shop({
      operations: {
        getOrder: {
          kind: 'query',
          description: 'Get an order.',
          requires: ['shop.read'],
          input: t.object({ mode: t.enum(['fast', 'Very Slow', '2x']) }),
          output: Order,
        },
      },
    });

    expect(issues([broken])).toEqual([
      'shop.getOrder.input.mode: enum value "Very Slow" must be lower_snake_case so every generator can name it',
      'shop.getOrder.input.mode: enum value "2x" must be lower_snake_case so every generator can name it',
    ]);
  });

  it('rejects contract names that collide once a generator transforms them', () => {
    // "shop" + "getOrder" and "shopGet" + "order" both become ShopGetOrder in Go.
    const shopGet = defineModule({
      name: 'shopGet',
      version: '1.0.0',
      description: 'A badly named module.',
      permissions: { read: 'Read.' },
      operations: {
        order: {
          kind: 'query',
          description: 'Collides.',
          requires: ['shopGet.read'],
          input: t.object({}),
          output: t.boolean(),
        },
      },
    });

    expect(issues([shop(), shopGet])).toContain(
      'operation shopGet.order: generates "ShopGetOrder", which operation shop.getOrder also generates',
    );
  });

  it('rejects names reserved by the generated SDK and OpenAPI', () => {
    const json = defineModule({
      name: 'json',
      version: '1.0.0',
      description: 'Collides with the SDK runtime.',
      permissions: { read: 'Read.' },
      operations: {
        get: {
          kind: 'query',
          description: 'Get.',
          requires: ['json.read'],
          input: t.object({}),
          output: defineType('json.Value', t.object({ raw: t.json() })),
        },
      },
    });

    expect(issues([json])).toEqual([
      'type json.Value: generates "JsonValue", which is reserved by the generated SDK or OpenAPI',
    ]);
  });
});

describe('warnings', () => {
  it('warns about permissions and errors nothing uses, without failing', () => {
    const { warnings } = compileWithWarnings([
      shop({
        permissions: { read: 'Read.', admin: 'Never required.' },
        errors: { GONE: { category: 'not_found', retryable: false, description: 'Never returned.' } },
      }),
    ]);

    expect(warnings).toEqual([
      { path: 'shop.admin', message: 'permission is declared but no operation requires it' },
      { path: 'shop.GONE', message: 'error is declared but no operation can return it' },
    ]);
  });

  it('has nothing to say about a clean contract', () => {
    expect(compileWithWarnings([shop()]).warnings).toEqual([]);
  });
});
