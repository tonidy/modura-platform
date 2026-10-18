import { canonicalJson, compile } from '@modura/compiler';
import { calculator, tape } from '@modura/example-calculator';
import { defineModule, t } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { generateSdk } from './index.ts';

const ir = JSON.parse(canonicalJson(compile([calculator, tape])));
const sdk = generateSdk(ir);

describe('generateSdk', () => {
  it('declares named types once, using refs and enums', () => {
    expect(sdk).toContain('export type CalculatorSlotName = string;');
    expect(sdk).toContain('export type CalculatorOperator = "add" | "subtract" | "multiply" | "divide";');
    expect(sdk).toContain('  slot: CalculatorSlotName;');
    expect(sdk).toContain('  result: CalculatorResult;');
    expect(sdk).toContain('  remainder?: number;');
    expect(sdk.match(/export interface CalculatorResult \{/g)).toHaveLength(1);
  });

  it('uses the runtime Money type and an empty record for an input without fields', () => {
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
    const prices = generateSdk(JSON.parse(canonicalJson(compile([shop]))));

    expect(prices).toContain('  price: Money;');
    expect(prices).toContain('export type ShopPriceInput = Record<string, never>;');
  });

  it('gives each operation a closed union of the error codes the IR lists', () => {
    expect(sdk).toMatch(/export type CalculatorRecallErrorCode =\n(  \| "[\w.]+"\n)*  \| "calculator\.SLOT_NOT_FOUND"/);
    expect(sdk).not.toMatch(/CalculatorRecallErrorCode =[^;]*IDEMPOTENCY/);
    expect(sdk).toMatch(/CalculatorStoreErrorCode =[^;]*"IDEMPOTENCY_KEY_REUSED"/);
  });

  it('requires an idempotency key only for idempotent operations', () => {
    expect(sdk).toContain(
      'store: (input: CalculatorStoreInput, options: IdempotentCallOptions): Promise<Result<CalculatorStoredResult, CalculatorStoreErrorCode>> =>',
    );
    expect(sdk).toContain(
      'recall: (input: CalculatorRecallInput, options?: CallOptions): Promise<Result<CalculatorStoredResult, CalculatorRecallErrorCode>> =>',
    );
  });

  it('types event payloads', () => {
    expect(sdk).toContain('export type CalculatorResultStoredEvent = CalculatorStoredResult;');
  });

  it('passes the owning service on every call when given a service map', () => {
    const routed = generateSdk(ir, { services: { calculator: 'calc-go', tape: 'tape-py' } });

    expect(routed).toContain('transport.call("calculator.store", input, { ...options, service: "calc-go" })');
    expect(routed).toContain('transport.call("tape.list", input, { ...options, service: "tape-py" })');
    expect(sdk).not.toContain('service:');
  });
});
