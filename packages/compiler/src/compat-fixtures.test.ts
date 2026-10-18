import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import { buildCompatFixtures } from './compat-fixtures.ts';

const file = fileURLToPath(new URL('../../../tests/compat-fixtures/fixtures.jsonl', import.meta.url));

describe('shared compatibility fixtures', () => {
  const fixtures = buildCompatFixtures();

  it('are checked in and current (UPDATE_FIXTURES=1 rewrites them)', () => {
    // JSON Lines: one case per line, keys in canonical order, so a diff shows which case changed.
    const expected = fixtures.map((f) => JSON.stringify(JSON.parse(canonicalJson(f)))).join('\n') + '\n';
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, expected);
    expect(readFileSync(file, 'utf8')).toBe(expected);
  });

  it('cover every severity of every rule', () => {
    const byName = new Map(fixtures.map((f) => [f.name, f]));
    const worst = (name: string) => {
      const severities = byName.get(name)!.changes.map((c) => c.severity);
      return severities.includes('breaking') ? 'breaking' : severities.includes('source') ? 'source' : 'safe';
    };

    expect(byName.get('identical')!.changes).toEqual([]);
    const expected: Record<string, string[]> = {
      breaking: [
        'input field removed', 'input required field added', 'input optional field became required',
        'input bound narrowed', 'input enum value removed', 'input pattern changed', 'input type changed',
        'output field removed', 'output required field became optional', 'output bound widened',
        'output enum value added', 'output type changed to json', 'output change through a named type',
        'operation removed', 'module removed', 'kind changed', 'permission added', 'became idempotent',
        'event removed', 'event payload field removed', 'event payload bound widened',
      ],
      source: ['named type renamed', 'named type inlined', 'inline type given a name'],
      safe: [
        'input optional field added', 'input required field became optional', 'input bound widened',
        'input bound removed', 'input enum value added', 'output field added',
        'output optional field became required', 'output bound narrowed', 'output enum value removed',
        'operation added', 'module added', 'permission removed', 'no longer idempotent',
        'error code added', 'mcp exposure removed', 'event added', 'event payload field added',
        'subscription added', 'subscription removed',
      ],
    };
    for (const [severity, names] of Object.entries(expected)) {
      for (const name of names) expect(worst(name), name).toBe(severity);
    }
  });

  it('apply the version rules', () => {
    const find = (name: string) => fixtures.find((f) => f.name === name)!;

    expect(find('breaking with a major bump').violations).toEqual([]);
    expect(find('breaking with a minor bump while 0.x').violations).toEqual([]);
    expect(find('breaking with a minor bump at 1.x').violations).toHaveLength(1);
    expect(find('breaking with a patch bump while 0.x').violations).toHaveLength(1);
    expect(find('module removed').violations).toEqual(['audit: removing a module always breaks its clients']);
    expect(find('named type renamed').violations[0]).toMatch(/^shop: source-breaking changes need/);
    expect(find('source-breaking with a major bump').violations).toEqual([]);
    expect(find('version went down').violations).toEqual(['shop: the version went down from 1.0.0 to 0.9.0']);
    expect(find('version went down with a breaking change').violations).toEqual([
      'shop: the version went down from 1.0.0 to 0.9.0',
    ]);
  });

  it('warn about compatible changes without a minor bump', () => {
    const find = (name: string) => fixtures.find((f) => f.name === name)!;

    expect(find('identical').warnings).toEqual([]);
    expect(find('compatible change with a minor bump').warnings).toEqual([]);
    expect(find('compatible change with only a patch bump').warnings).toEqual([
      'shop: compatible changes usually come with a minor version bump, but the version went 1.0.0 -> 1.0.1',
    ]);
    expect(find('output field added').warnings).toHaveLength(1);
  });
});
