import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical-json.ts';
import { checkCompatibility } from '../compat.ts';
import { compile } from '../compile.ts';
import type { IrDocument } from '../ir.ts';
import { contractArbitrary, editArbitrary } from './arbitraries.ts';

// Guards the generators themselves: properties over trivial contracts prove nothing.
describe('arbitraries', () => {
  const samples = fc.sample(contractArbitrary, { seed: 7, numRuns: 200 }).map((m) => JSON.parse(canonicalJson(compile(m))) as IrDocument);
  const json = samples.map((ir) => JSON.stringify(ir));

  it('cover every type kind, events, subscriptions and named types', () => {
    for (const kind of ['string', 'integer', 'boolean', 'timestamp', 'money', 'json', 'enum', 'array', 'object', 'ref']) {
      expect(json.some((s) => s.includes(`"kind":"${kind}"`)), kind).toBe(true);
    }
    expect(samples.some((ir) => Object.keys(ir.modules.alpha!.events).length > 0)).toBe(true);
    expect(samples.some((ir) => (ir.modules.beta?.subscribes.length ?? 0) > 0)).toBe(true);
    expect(samples.filter((ir) => Object.keys(ir.types).length > 0).length).toBeGreaterThan(50);
  });

  it('produce edits of every severity and both kinds of version outcome', () => {
    const reports = samples.flatMap((ir, i) =>
      fc.sample(editArbitrary(ir), { seed: i, numRuns: 3 }).map((next) => checkCompatibility(ir, next)),
    );
    const severities = new Set(reports.flatMap((r) => r.changes.map((c) => c.severity)));
    expect([...severities].sort()).toEqual(['breaking', 'safe', 'source']);
    expect(reports.some((r) => r.violations.length > 0)).toBe(true);
    expect(reports.some((r) => r.changes.length > 0 && r.violations.length === 0)).toBe(true);
    expect(reports.some((r) => r.warnings.length > 0)).toBe(true);
  });
});
