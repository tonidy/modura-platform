import { defineModule, defineType, type ModuleDefinition, type NamedType, t } from '@modura/schema';
import { SlotName } from './calculator.ts';

// The tape a desk calculator prints: a record of stored results, built only from the
// calculator's `resultStored` event. A second module, so the example has a consumer
// of another module's event and a second service.

export const Entry: NamedType = defineType(
  'tape.Entry',
  t.object({ slot: SlotName, value: t.integer(), storedAt: t.timestamp() }),
);

export const tape: ModuleDefinition = defineModule({
  name: 'tape',
  version: '0.1.0',
  description: 'A running record of stored results.',
  subscribes: ['calculator.resultStored'],
  permissions: {
    read: 'Read the tape.',
  },
  operations: {
    list: {
      kind: 'query',
      description: 'The latest stored results, newest first.',
      requires: ['tape.read'],
      input: t.object({ limit: t.optional(t.integer({ minimum: 1, maximum: 100 })) }),
      output: t.object({ entries: t.array(Entry) }),
      expose: { mcp: true },
    },
  },
});
