import { compile } from '@modura/compiler';
import { calculator, tape } from '@modura/example-calculator';
import { defineModule, t } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from './index.ts';

const options = { title: 'Test API', version: '0.0.0' };
const ir = compile([calculator, tape]);
const spec = generateOpenApi(ir, options) as any;

describe('generateOpenApi', () => {
  it('maps every operation to POST /v1/{module}.{operation} with contract metadata', () => {
    const evaluate = spec.paths['/v1/calculator.evaluate'].post;

    expect(Object.keys(spec.paths)).toEqual([
      '/v1/calculator.evaluate',
      '/v1/calculator.recall',
      '/v1/calculator.store',
      '/v1/tape.list',
    ]);
    expect(evaluate).toMatchObject({
      operationId: 'calculatorEvaluate',
      security: [{ bearerAuth: [] }],
      'x-modura-requires': ['calculator.use'],
      'x-modura-kind': 'query',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CalculatorEvaluateInput' } } },
      },
    });
    expect(evaluate.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CalculatorResult',
    });
  });

  it('turns the idempotent trait into a required Idempotency-Key header, on commands only', () => {
    const store = spec.paths['/v1/calculator.store'].post;
    const evaluate = spec.paths['/v1/calculator.evaluate'].post;

    expect(store.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
    expect(store.responses['200'].headers).toHaveProperty('Idempotent-Replayed');
    expect(evaluate.parameters).toBeUndefined();
  });

  it('groups error codes by the HTTP status their category maps to', () => {
    const store = spec.paths['/v1/calculator.store'].post.responses;

    expect(store['409']['x-modura-error-codes']).toEqual(['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']);
    expect(store['422']['x-modura-error-codes']).toEqual(['calculator.MEMORY_FULL']);
    expect(spec.paths['/v1/calculator.evaluate'].post.responses['422']['x-modura-error-codes']).toEqual([
      'calculator.DIVISION_BY_ZERO',
    ]);
    expect(spec.paths['/v1/calculator.recall'].post.responses['404']['x-modura-error-codes']).toEqual([
      'calculator.SLOT_NOT_FOUND',
    ]);
  });

  it('emits closed object schemas with sorted required fields and shared refs', () => {
    expect(spec.components.schemas.CalculatorStoredResult).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['result', 'slot', 'storedAt'],
      properties: {
        slot: { $ref: '#/components/schemas/CalculatorSlotName' },
        result: { $ref: '#/components/schemas/CalculatorResult' },
      },
    });
    // Left undefined so canonical serialization drops it; OpenAPI 3.0 rejects `required: []`.
    expect(spec.components.schemas.TapeListInput.required).toBeUndefined();
  });

  it('refers to the shared Money schema for money fields', () => {
    const shop = defineModule({
      name: 'shop',
      version: '0.1.0',
      description: 'Prices.',
      permissions: { read: 'Read prices.' },
      operations: {
        price: {
          kind: 'query',
          description: 'One price.',
          requires: ['shop.read'],
          input: t.object({}),
          output: t.object({ price: t.money() }),
        },
      },
    });
    const prices = generateOpenApi(compile([shop]), options) as any;

    expect(prices.components.schemas.ShopPriceOutput.properties.price).toEqual({ $ref: '#/components/schemas/Money' });
    expect(prices.components.schemas.Money).toMatchObject({ required: ['amountMinor', 'currency'] });
  });

  it('refuses to generate two schemas with the same name', () => {
    const clash = defineModule({
      name: 'clash',
      version: '0.1.0',
      description: 'Its operation input name collides with a named type.',
      permissions: { read: 'Read.' },
      operations: {
        thing: {
          kind: 'query',
          description: 'Collides.',
          requires: ['clash.read'],
          input: t.object({}),
          output: t.object({ value: t.boolean() }),
        },
      },
    });
    const clashIr = compile([clash]);
    const withCollision = { ...clashIr, types: { 'clash.ThingInput': { kind: 'boolean' as const } } };

    expect(() => generateOpenApi(withCollision, options)).toThrow(/ClashThingInput/);
  });

  it("leaves out other services' operations and the types only they use", () => {
    const calculatorDoc = generateOpenApi(ir, { ...options, modules: ['calculator'] }) as any;
    const tapeDoc = generateOpenApi(ir, { ...options, modules: ['tape'] }) as any;
    const names = (doc: any) => Object.keys(doc.components.schemas);

    expect(JSON.stringify(calculatorDoc)).not.toMatch(/tape/i);
    expect(Object.keys(tapeDoc.paths)).toEqual(['/v1/tape.list']);
    // The subscribed event comes with every type its payload needs, and nothing else from the calculator.
    expect(tapeDoc.components.schemas.CalculatorResultStoredEvent['x-modura-event']).toBe('calculator.resultStored');
    expect(names(tapeDoc)).toContain('CalculatorResult');
    expect(names(tapeDoc)).not.toContain('CalculatorEvaluateInput');
    expect(names(tapeDoc)).not.toContain('CalculatorOperator');
    // Without a filter nothing is pruned.
    expect(names(generateOpenApi(ir, options))).toEqual(
      expect.arrayContaining([...names(calculatorDoc), ...names(tapeDoc)]),
    );
  });
});
