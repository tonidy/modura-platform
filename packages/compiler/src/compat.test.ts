import { defineModule, t, type ModuleDefinition, type OperationDefinition } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { checkCompatibility } from './compat.ts';
import { compile } from './compile.ts';

const getItem: OperationDefinition = {
  kind: 'query',
  description: 'Get one item.',
  requires: ['shop.read'],
  input: t.object({ id: t.string(), note: t.optional(t.string({ maxLength: 50 })) }),
  output: t.object({ id: t.string(), status: t.enum(['open', 'closed']) }),
};

function shop(version: string, operation: Partial<OperationDefinition> = {}): ModuleDefinition {
  return defineModule({
    name: 'shop',
    version,
    description: 'A test shop.',
    permissions: { read: 'Read.', admin: 'Administer.' },
    operations: { getItem: { ...getItem, ...operation } },
  });
}

function compare(next: ModuleDefinition) {
  return checkCompatibility(compile([shop('1.0.0')]), compile([next]));
}

function breaking(next: ModuleDefinition): string[] {
  return compare(next)
    .changes.filter((c) => c.severity === 'breaking')
    .map((c) => `${c.path}: ${c.message}`);
}

describe('checkCompatibility', () => {
  it('reports no changes for an identical contract', () => {
    expect(compare(shop('1.0.0'))).toEqual({ changes: [], violations: [], warnings: [] });
  });

  it('treats input narrowing as breaking and input widening as safe', () => {
    const narrowed = shop('1.0.0', {
      input: t.object({ id: t.string(), note: t.string({ maxLength: 20 }) }),
    });

    expect(breaking(narrowed)).toEqual([
      'shop.getItem.input.note: became required',
      'shop.getItem.input.note: maxLength changed from 50 to 20',
    ]);
    expect(breaking(shop('1.0.0', { input: t.object({ id: t.string(), note: t.optional(t.string()) }) }))).toEqual([]);
  });

  it('treats output additions clients cannot expect as breaking', () => {
    const next = shop('1.0.0', {
      output: t.object({
        id: t.string(),
        status: t.enum(['open', 'closed', 'archived']),
        extra: t.optional(t.boolean()),
      }),
    });

    expect(breaking(next)).toEqual(['shop.getItem.output.status: enum value "archived" added']);
    expect(compare(next).changes.map((c) => c.message)).toContain('field added');
  });

  it('treats a new permission requirement as breaking', () => {
    expect(breaking(shop('1.0.0', { requires: ['shop.read', 'shop.admin'] }))).toEqual([
      'shop.getItem: now requires shop.admin',
    ]);
  });

  it('demands a major bump for breaking changes, or a minor bump while 0.x', () => {
    const removedField = { output: t.object({ id: t.string() }) };

    expect(compare(shop('1.0.0', removedField)).violations).toEqual([
      'shop: breaking changes need a major version bump (minor while 0.x), but the version went 1.0.0 -> 1.0.0',
    ]);
    expect(compare(shop('2.0.0', removedField)).violations).toEqual([]);

    const zero = checkCompatibility(compile([shop('0.1.0')]), compile([shop('0.2.0', removedField)]));
    expect(zero.violations).toEqual([]);
  });

  it('always flags removing a module or an operation', () => {
    const empty = defineModule({ ...shop('9.0.0'), operations: {} });

    expect(breaking(empty)).toEqual(['shop.getItem: operation removed']);
    expect(checkCompatibility(compile([shop('1.0.0')]), compile([])).violations).toEqual([
      'shop: removing a module always breaks its clients',
    ]);
  });
});
