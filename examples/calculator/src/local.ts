/**
 * Both services of the example, in-process. A Modura client talks to its services
 * through a `Transport`; this one answers the calls itself instead of sending HTTP,
 * so the example runs without a server while the CLI still uses the generated client.
 * The implementation types come from the generated client too, so a contract change
 * that this code does not follow stops it compiling.
 */
import type { ModuraError, Result, Transport, TransportCallOptions } from '@modura/sdk';
import type {
  CalculatorEvaluateInput,
  CalculatorRecallInput,
  CalculatorResult,
  CalculatorResultStoredEvent,
  CalculatorStoreInput,
  CalculatorStoredResult,
  TapeEntry,
  TapeListInput,
  TapeListOutput,
} from './generated/client.ts';

/** How many slots the memory has. */
export const MEMORY_SLOTS = 8;

/** Everything both services keep, serialisable so the CLI can save it between runs. */
export interface State {
  slots: Record<string, CalculatorStoredResult>;
  tape: TapeEntry[];
  /** Stored results by idempotency key, so a retried store is replayed, not repeated. */
  stores: Record<string, CalculatorStoredResult>;
}

export function emptyState(): State {
  return { slots: {}, tape: [], stores: {} };
}

type Outcome = Result<unknown, string>;

export function createLocalTransport(state: State, now: () => Date = () => new Date()): Transport {
  // The tape service's subscription to calculator.resultStored. A real deployment would
  // deliver the event through an outbox or a broker; here it is a function call.
  const onResultStored = (event: CalculatorResultStoredEvent) => {
    state.tape.push({ slot: event.slot, value: event.result.value, storedAt: event.storedAt });
  };

  const handlers: Record<string, (input: never, options: TransportCallOptions) => Outcome> = {
    'calculator.evaluate': (input: CalculatorEvaluateInput) => evaluate(input),

    'calculator.store': (input: CalculatorStoreInput, options) => {
      const key = options.idempotencyKey;
      if (key === undefined) return failure('VALIDATION_FAILED', 'calculator.store needs an idempotency key.');
      const earlier = state.stores[key];
      if (earlier !== undefined) return { ok: true, value: earlier, replayed: true };
      if (state.slots[input.slot] === undefined && Object.keys(state.slots).length >= MEMORY_SLOTS) {
        return failure('calculator.MEMORY_FULL', `All ${MEMORY_SLOTS} slots are taken. Store into an existing slot.`);
      }
      const stored: CalculatorStoredResult = { slot: input.slot, result: input.result, storedAt: now().toISOString() };
      state.slots[input.slot] = stored;
      state.stores[key] = stored;
      onResultStored(stored);
      return { ok: true, value: stored, replayed: false };
    },

    'calculator.recall': (input: CalculatorRecallInput) => {
      const stored = state.slots[input.slot];
      return stored === undefined
        ? failure('calculator.SLOT_NOT_FOUND', `Nothing is stored in ${input.slot}.`)
        : { ok: true, value: stored, replayed: false };
    },

    'tape.list': (input: TapeListInput) => {
      const output: TapeListOutput = { entries: state.tape.toReversed().slice(0, input.limit ?? 20) };
      return { ok: true, value: output, replayed: false };
    },
  };

  return {
    async call<Value, Code extends string>(operation: string, input: unknown, options: TransportCallOptions = {}) {
      const handler = handlers[operation];
      const outcome = handler === undefined ? failure('INTERNAL', `No local handler for ${operation}.`) : handler(input as never, options);
      return outcome as Result<Value, Code>;
    },
  };
}

function evaluate({ left, operator, right }: CalculatorEvaluateInput): Outcome {
  let result: CalculatorResult;
  switch (operator) {
    case 'add':
      result = { value: left + right };
      break;
    case 'subtract':
      result = { value: left - right };
      break;
    case 'multiply':
      result = { value: left * right };
      break;
    case 'divide':
      if (right === 0) return failure('calculator.DIVISION_BY_ZERO', 'Cannot divide by zero.');
      // `+ 0` turns JavaScript's -0 into 0, which JSON cannot tell apart anyway.
      result = { value: Math.trunc(left / right) + 0, remainder: (left % right) + 0 };
      break;
  }
  return { ok: true, value: result, replayed: false };
}

function failure(code: string, message: string): Outcome {
  const error: ModuraError = { code, message, retryable: false };
  return { ok: false, error };
}
