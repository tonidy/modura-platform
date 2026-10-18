import { defineModule, defineType, type ModuleDefinition, type NamedType, t } from '@modura/schema';

// Integer arithmetic with a small named memory. Small on purpose, but it uses every
// kind of thing a contract can say: queries and an idempotent command, domain errors
// in more than one category, named types shared by reference, an enum, and an event
// that another module (`tape`) subscribes to.

/** Operands are bounded so every result, including a product, is a safe integer. */
const operand = t.integer({ minimum: -1_000_000, maximum: 1_000_000 });

export const Operator: NamedType = defineType(
  'calculator.Operator',
  t.enum(['add', 'subtract', 'multiply', 'divide'], { description: 'What to do with the two operands.' }),
);

export const Result: NamedType = defineType(
  'calculator.Result',
  t.object({
    value: t.integer({ description: 'The result. For divide, the quotient rounded towards zero.' }),
    remainder: t.optional(t.integer({ description: 'For divide only: what is left over.' })),
  }),
);

export const SlotName: NamedType = defineType(
  'calculator.SlotName',
  t.string({ pattern: '^[a-z][a-z0-9_]{0,31}$', description: 'A memory slot, such as `answer`.' }),
);

export const StoredResult: NamedType = defineType(
  'calculator.StoredResult',
  t.object({ slot: SlotName, result: Result, storedAt: t.timestamp() }),
);

export const calculator: ModuleDefinition = defineModule({
  name: 'calculator',
  version: '0.1.0',
  description: 'Integer arithmetic with a named memory.',
  events: {
    resultStored: {
      description: 'A result was stored in a memory slot.',
      payload: StoredResult,
    },
  },
  permissions: {
    use: 'Evaluate expressions and recall stored results.',
    write: 'Store results in memory.',
  },
  errors: {
    DIVISION_BY_ZERO: {
      category: 'unprocessable',
      retryable: false,
      description: 'The right operand of a division is zero.',
    },
    MEMORY_FULL: {
      category: 'unprocessable',
      retryable: false,
      description: 'Every memory slot is taken. Overwrite an existing slot instead.',
    },
    SLOT_NOT_FOUND: {
      category: 'not_found',
      retryable: false,
      description: 'Nothing is stored in this slot.',
    },
  },
  operations: {
    evaluate: {
      kind: 'query',
      description: 'Apply an operator to two integers.',
      requires: ['calculator.use'],
      input: t.object({ left: operand, operator: Operator, right: operand }),
      output: Result,
      errors: ['DIVISION_BY_ZERO'],
      expose: { mcp: true },
    },
    store: {
      kind: 'command',
      description: 'Store a result in a memory slot, replacing what was there. Retrying with the same key stores it once.',
      requires: ['calculator.write'],
      idempotent: true,
      input: t.object({ slot: SlotName, result: Result }),
      output: StoredResult,
      errors: ['MEMORY_FULL'],
    },
    recall: {
      kind: 'query',
      description: 'Read the result stored in a memory slot.',
      requires: ['calculator.use'],
      input: t.object({ slot: SlotName }),
      output: StoredResult,
      errors: ['SLOT_NOT_FOUND'],
      expose: { mcp: true },
    },
  },
});
