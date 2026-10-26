import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tsx = join(import.meta.dirname, '../../../node_modules/.bin/tsx');
const main = join(import.meta.dirname, 'main.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI against an empty file registry, which it must leave empty. */
function run(args: string): { status: number; output: string; registry: string[] } {
  const registry = mkdtempSync(join(tmpdir(), 'modura-cli-'));
  dirs.push(registry);
  const options = { encoding: 'utf8' as const, env: { ...process.env, MODURA_REGISTRY_URL: `file:${registry}` } };
  try {
    return { status: 0, output: execFileSync(tsx, [main, ...args.split(' ')], options), registry: readdirSync(registry) };
  } catch (error) {
    const { status, stdout, stderr } = error as { status: number; stdout: string; stderr: string };
    return { status, output: stdout + stderr, registry: readdirSync(registry) };
  }
}

describe('help', () => {
  it.each(['--help', '-h', 'publish --help', 'help'])('modura %s prints usage and runs nothing', (args) => {
    expect(run(args)).toEqual({ status: 0, output: expect.stringContaining('Usage:'), registry: [] });
  });
});

describe('flags', () => {
  it.each([
    ['publish --dry-run', 'Unknown option --dry-run.'],
    ['publish --registry', '--registry needs a value.'],
    ['publish --registry --strict', '--registry needs a value.'],
    ['generate --chek', 'Unknown option --chek.'],
    ['compat --against', '--against needs a value.'],
    ['registry verify --since', '--since needs a value.'],
  ])('modura %s fails before running', (args, message) => {
    expect(run(args)).toEqual({ status: 1, output: expect.stringContaining(message), registry: [] });
  });
});
