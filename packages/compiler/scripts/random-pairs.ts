/**
 * Writes seeded random IR pairs with the TypeScript compatibility report for each,
 * as JSON Lines, for the Go checker to compare against (plan M6).
 *
 *   tsx packages/compiler/scripts/random-pairs.ts <out.jsonl> [seed] [count]
 *
 * scripts/compat-parity.sh runs this and then the Go test.
 */
import { writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { canonicalJson, checkCompatibility, compile, type IrDocument } from '../src/index.ts';
import { contractArbitrary, editArbitrary } from '../src/testing/arbitraries.ts';

const [out, seedArg = '20261011', countArg = '400'] = process.argv.slice(2);
if (!out) throw new Error('usage: random-pairs.ts <out.jsonl> [seed] [count]');

const pairs = fc.sample(
  contractArbitrary.chain((modules) => {
    const previous = JSON.parse(canonicalJson(compile(modules))) as IrDocument;
    return editArbitrary(previous).map((next) => ({ previous, next }));
  }),
  { seed: Number(seedArg), numRuns: Number(countArg) },
);

const lines = pairs.map(({ previous, next }, i) =>
  JSON.stringify({ name: `random-${seedArg}-${i}`, previous, next, ...checkCompatibility(previous, next) }),
);
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`Wrote ${pairs.length} random pairs (seed ${seedArg}) to ${out}`);
