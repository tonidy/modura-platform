import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.ts';
import { irSha256 } from './hash.ts';
import { buildIrFixtures } from './ir-fixtures.ts';
import { validateIr } from './validate.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'tests/ir-fixtures');
const update = process.env.UPDATE_FIXTURES === '1';

function expectFile(path: string, content: string) {
  if (update) writeFileSync(path, content);
  expect(readFileSync(path, 'utf8'), `${path} is stale; run UPDATE_FIXTURES=1`).toBe(content);
}

describe('shared IR fixtures', () => {
  const fixtures = buildIrFixtures();

  it('are checked in and current (UPDATE_FIXTURES=1 rewrites them)', () => {
    for (const kind of ['valid', 'invalid'] as const) {
      const folder = join(dir, kind);
      if (update) {
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder, { recursive: true });
      }
      const names = Object.keys(fixtures[kind]).sort();
      for (const name of names) expectFile(join(folder, `${name}.json`), canonicalJson(fixtures[kind][name]));
      expect(readdirSync(folder).sort(), `${folder} has extra files`).toEqual(names.map((n) => `${n}.json`));
    }
  });

  it('valid documents pass the JSON Schema and the semantic rules', () => {
    for (const [name, document] of Object.entries(fixtures.valid)) {
      expect(validateIr(document), name).toEqual([]);
    }
  });

  it('invalid documents are rejected, each for the reason in its name', () => {
    for (const [name, document] of Object.entries(fixtures.invalid)) {
      expect(validateIr(document), name).not.toEqual([]);
    }
    expect(validateIr(fixtures.invalid['reference-cycle'])).toEqual([
      'types: reference cycle shop.Item -> shop.Item',
    ]);
  });

  it('record the canonical hash of every valid document for the Go side to match', () => {
    const hashes: Record<string, string> = {};
    for (const [name, document] of Object.entries(fixtures.valid)) hashes[`valid/${name}.json`] = irSha256(document);
    expectFile(join(dir, 'hashes.json'), canonicalJson(hashes));
  });

  it('agree with the hash `modura generate` writes next to the real IR', () => {
    const generated = JSON.parse(readFileSync(join(root, 'generated/ir/modura.ir.json'), 'utf8'));
    expect(validateIr(generated)).toEqual([]);
    expect(readFileSync(join(root, 'generated/ir/modura.ir.sha256'), 'utf8')).toBe(`${irSha256(generated)}\n`);
  });
});
