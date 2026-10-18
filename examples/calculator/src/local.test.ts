import { describe, expect, it } from 'vitest';
import { createModuraClient } from './generated/client.ts';
import { createLocalTransport, emptyState, MEMORY_SLOTS } from './local.ts';

const at = new Date('2026-10-18T09:00:00.000Z');

function setup() {
  const state = emptyState();
  return { state, client: createModuraClient(createLocalTransport(state, () => at)) };
}

describe('the calculator, through its generated client', () => {
  it('evaluates each operator, with a remainder for division', async () => {
    const { client } = setup();
    const results = await Promise.all([
      client.calculator.evaluate({ left: 7, operator: 'add', right: 2 }),
      client.calculator.evaluate({ left: 7, operator: 'subtract', right: 2 }),
      client.calculator.evaluate({ left: 7, operator: 'multiply', right: 2 }),
      client.calculator.evaluate({ left: -7, operator: 'divide', right: 2 }),
    ]);

    expect(results.map((r) => r.ok && r.value)).toEqual([
      { value: 9 },
      { value: 5 },
      { value: 14 },
      { value: -3, remainder: -1 },
    ]);
  });

  it('refuses to divide by zero with the contract error code', async () => {
    const { client } = setup();
    const result = await client.calculator.evaluate({ left: 1, operator: 'divide', right: 0 });

    expect(result).toMatchObject({ ok: false, error: { code: 'calculator.DIVISION_BY_ZERO' } });
  });

  it('stores once per idempotency key, and the tape hears about it through the event', async () => {
    const { client } = setup();
    const first = await client.calculator.store({ slot: 'answer', result: { value: 42 } }, { idempotencyKey: 'k1' });
    const retry = await client.calculator.store({ slot: 'answer', result: { value: 42 } }, { idempotencyKey: 'k1' });

    expect(first).toMatchObject({ ok: true, replayed: false, value: { slot: 'answer', storedAt: at.toISOString() } });
    expect(retry).toMatchObject({ ok: true, replayed: true });
    expect(await client.calculator.recall({ slot: 'answer' })).toMatchObject({ ok: true, value: { result: { value: 42 } } });
    expect(await client.tape.list({})).toEqual({
      ok: true,
      replayed: false,
      value: { entries: [{ slot: 'answer', value: 42, storedAt: at.toISOString() }] },
    });
  });

  it('reports a missing slot and a full memory', async () => {
    const { client } = setup();
    expect(await client.calculator.recall({ slot: 'nothing' })).toMatchObject({
      ok: false,
      error: { code: 'calculator.SLOT_NOT_FOUND' },
    });

    for (let i = 0; i < MEMORY_SLOTS; i++) {
      await client.calculator.store({ slot: `s${i}`, result: { value: i } }, { idempotencyKey: `k${i}` });
    }
    const full = await client.calculator.store({ slot: 'extra', result: { value: 1 } }, { idempotencyKey: 'extra' });
    const overwrite = await client.calculator.store({ slot: 's0', result: { value: 9 } }, { idempotencyKey: 'again' });

    expect(full).toMatchObject({ ok: false, error: { code: 'calculator.MEMORY_FULL' } });
    expect(overwrite).toMatchObject({ ok: true, value: { slot: 's0', result: { value: 9 } } });
  });

  it('lists the tape newest first, limited', async () => {
    const { client } = setup();
    for (const [i, slot] of ['a', 'b', 'c'].entries()) {
      await client.calculator.store({ slot, result: { value: i } }, { idempotencyKey: slot });
    }

    const listed = await client.tape.list({ limit: 2 });
    expect(listed.ok && listed.value.entries.map((e) => e.slot)).toEqual(['c', 'b']);
  });
});
