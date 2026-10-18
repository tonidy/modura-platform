import { describe, expect, it } from 'vitest';
import { t } from './index.ts';

describe('t.object', () => {
  it('marks plain fields required and wrapped fields optional', () => {
    const type = t.object({ id: t.string(), note: t.optional(t.string()) });

    expect(type.fields).toEqual({
      id: { type: { kind: 'string' }, optional: false },
      note: { type: { kind: 'string' }, optional: true },
    });
  });

  it('keeps options next to the normalized fields', () => {
    expect(t.object({}, { description: 'Empty input.' })).toEqual({
      kind: 'object',
      fields: {},
      description: 'Empty input.',
    });
  });
});
