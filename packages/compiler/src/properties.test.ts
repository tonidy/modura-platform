import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import { checkCompatibility } from './compat.ts';
import { compile } from './compile.ts';
import { irSha256 } from './hash.ts';
import type { IrDocument } from './ir.ts';
import { contractArbitrary, editArbitrary, reverseKeys } from './testing/arbitraries.ts';
import { validateIr } from './validate.ts';

// Property-based tests for the schema engine (plan M6). Seeded, so a failure is
// reproducible; FC_SEED and FC_RUNS explore further locally.
fc.configureGlobal({
  seed: Number(process.env.FC_SEED ?? 20261011),
  numRuns: Number(process.env.FC_RUNS ?? 150),
});

const canonical = (ir: IrDocument): IrDocument => JSON.parse(canonicalJson(ir));

describe('compiler properties', () => {
  it('compiles to the same bytes whatever order the source declares things in', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        expect(canonicalJson(compile(reverseKeys(modules)))).toBe(canonicalJson(compile(modules)));
      }),
    );
  });

  it('only produces documents that pass the IR JSON Schema and semantic rules', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        expect(validateIr(canonical(compile(modules)))).toEqual([]);
      }),
    );
  });

  it('only uses ASCII object keys, so every language sorts them the same way', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const keys: string[] = [];
        JSON.parse(canonicalJson(compile(modules)), (key, value) => {
          keys.push(key);
          return value;
        });
        expect(keys.every((key) => /^[\x20-\x7e]*$/.test(key))).toBe(true);
      }),
    );
  });

  it('hashes a document the same however its keys are ordered', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const ir = compile(modules);
        expect(irSha256(reverseKeys(ir))).toBe(irSha256(ir));
      }),
    );
  });
});

describe('compatibility properties', () => {
  it('finds nothing when a document is compared with itself', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const ir = canonical(compile(modules));
        expect(checkCompatibility(ir, ir)).toEqual({ changes: [], violations: [], warnings: [] });
      }),
    );
  });

  it('never calls a new optional output field breaking', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const before = canonical(compile(modules));
        const after = structuredClone(before) as any;
        for (const module of Object.values(after.modules) as any[]) {
          for (const op of Object.values(module.operations) as any[]) {
            if (op.output.kind === 'object') op.output.fields.zAddedLater = { required: false, type: { kind: 'boolean' } };
          }
        }
        const severities = checkCompatibility(before, after).changes.map((c) => c.severity);
        expect(severities.filter((s) => s !== 'safe')).toEqual([]);
      }),
    );
  });

  it('keeps edited documents valid, so random parity pairs are meaningful', () => {
    fc.assert(
      fc.property(
        contractArbitrary.chain((modules) => {
          const ir = canonical(compile(modules));
          return editArbitrary(ir).map((next) => ({ ir, next }));
        }),
        ({ next }) => {
          expect(validateIr(next)).toEqual([]);
        },
      ),
    );
  });
});
