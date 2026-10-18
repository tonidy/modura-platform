import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, compile, type IrDocument } from '@modura/compiler';
import { calculator, tape } from '@modura/example-calculator';
import { describe, expect, it } from 'vitest';
import {
  formatRelease,
  gitHistory,
  latestReleaseFile,
  nextRelease,
  releaseFileName,
  verifyReleaseFiles,
  type ReleaseFile,
} from './file-registry.ts';

const AT = new Date('2026-10-17T09:00:00.000Z');
const current = JSON.parse(canonicalJson(compile([calculator, tape]))) as IrDocument;

interface Fixture {
  readonly name: string;
  readonly previous: IrDocument;
  readonly next: IrDocument;
  readonly changes: unknown[];
  readonly violations: string[];
}

// The compatibility cases the Go registry passes too (tests/compat-fixtures). They
// leave platformErrors empty, which a published document cannot, so it is filled in.
const fixtures = readFileSync(new URL('../../../tests/compat-fixtures/fixtures.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Fixture)
  .map((f) => ({
    ...f,
    previous: { ...f.previous, platformErrors: current.platformErrors },
    next: { ...f.next, platformErrors: current.platformErrors },
  }));

function fixture(name: string): Fixture {
  const found = fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
}

function release(latest: ReleaseFile | null, ir: unknown): ReleaseFile {
  const result = nextRelease(latest, ir, 'tester', AT);
  if (!result.ok) throw new Error(`${result.rejection.code}: ${result.rejection.message}`);
  return result.file;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'modura-releases-'));
}

/** A folder with release 1 and a compatible release 2. */
function history(dir = tempDir()): string {
  const { previous, next } = fixture('input optional field added');
  const first = release(null, previous);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, releaseFileName(1)), formatRelease(first));
  writeFileSync(join(dir, releaseFileName(2)), formatRelease(release(first, next)));
  return dir;
}

function edit(path: string, change: (file: ReleaseFile) => void): void {
  const file = JSON.parse(readFileSync(path, 'utf8')) as ReleaseFile;
  change(file);
  writeFileSync(path, formatRelease(file));
}

describe('publishing to files', () => {
  it('writes release 1 with the summary the server would return', () => {
    const { release: first, ir } = release(null, current);

    expect(first.summary).toEqual({
      number: 1,
      publishedAt: '2026-10-17T09:00:00.000Z',
      publishedBy: 'tester',
      irVersion: '1.0.0',
      irSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      modules: [
        { name: 'calculator', version: '0.1.0' },
        { name: 'tape', version: '0.1.0' },
      ],
    });
    expect(first.changes).toEqual([]);
    expect(ir).toEqual(current);
  });

  it('refuses an identical document and an invalid one, with the server codes', () => {
    const first = release(null, current);

    expect(nextRelease(first, current, 'tester', AT)).toEqual({
      ok: false,
      rejection: { code: 'registry.NOTHING_TO_PUBLISH', message: 'The document is identical to release 1.' },
    });
    expect(nextRelease(null, { irVersion: '1.0.0' }, 'tester', AT)).toMatchObject({
      ok: false,
      rejection: { code: 'registry.INVALID_IR' },
    });
    expect(nextRelease(null, { ...current, irVersion: '0.2.0' }, 'tester', AT)).toMatchObject({
      ok: false,
      rejection: { message: 'IR 0.2.0 can still be read, but new releases must use IR 1.x.' },
    });
  });

  // The Go registry runs the same fixtures through the same rules (ADR-0008), and
  // builds its rejection message the same way, so both backends agree case by case.
  it.each(fixtures.map((f) => [f.name, f] as const))('agrees with the shared compatibility case: %s', (_, f) => {
    const first = release(null, f.previous);
    const result = nextRelease(first, f.next, 'tester', AT);

    if (f.violations.length > 0) {
      expect(result).toEqual({
        ok: false,
        rejection: { code: 'registry.INCOMPATIBLE_CHANGE', message: `The release breaks clients: ${f.violations[0]}` },
      });
    } else if (f.changes.length === 0) {
      expect(result).toMatchObject({ ok: false, rejection: { code: 'registry.NOTHING_TO_PUBLISH' } });
    } else {
      expect(result.ok && result.file.release.changes).toEqual(f.changes);
    }
  });
});

describe('registry verify', () => {
  it('accepts a history written by publish', () => {
    const dir = history();
    expect(verifyReleaseFiles(dir)).toEqual([]);
    expect(latestReleaseFile(dir)?.release.summary.number).toBe(2);
  });

  it('rejects a gap in the numbering', () => {
    const dir = history();
    renameSync(join(dir, '000002.json'), join(dir, '000003.json'));
    expect(verifyReleaseFiles(dir)).toContain(
      '000003.json: expected 000002.json; release numbers start at 1 with no gaps',
    );
  });

  it('rejects a renamed file and anything that is not a release', () => {
    const dir = history();
    renameSync(join(dir, '000002.json'), join(dir, 'release-2.json'));
    expect(verifyReleaseFiles(dir)).toEqual(['release-2.json: not a release file (expected names like 000001.json)']);
  });

  it('rejects an edited IR through its hash', () => {
    const dir = history();
    edit(join(dir, '000002.json'), (file) => {
      (file.ir as { modules: Record<string, { description: string }> }).modules.shop!.description = 'Edited.';
    });
    expect(verifyReleaseFiles(dir)).toEqual([
      expect.stringMatching(/^000002\.json: summary\.irSha256 does not match the IR/),
    ]);
  });

  it('rejects a file reformatted by hand', () => {
    const dir = history();
    const path = join(dir, '000001.json');
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))));
    expect(verifyReleaseFiles(dir)).toEqual([
      '000001.json: not in canonical form; release files are written by `modura publish`, never by hand',
    ]);
  });

  it('rejects a file that is not shaped like a release, using the registry contract', () => {
    const dir = history();
    edit(join(dir, '000001.json'), (file) => {
      (file.release as { summary: object }).summary = { ...file.release.summary, extra: true };
    });
    expect(verifyReleaseFiles(dir)).toEqual(['000001.json: /release/summary must NOT have additional properties']);
  });

  it('rejects module versions that do not match the IR', () => {
    const dir = history();
    edit(join(dir, '000001.json'), (file) => {
      file.release.summary.modules = [{ name: 'shop', version: '9.9.9' }];
    });
    expect(verifyReleaseFiles(dir)).toEqual(['000001.json: summary.modules does not match the module versions in the IR']);
  });
});

describe('registry verify --since', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  /** A repository whose `main` has releases 1 and 2 in contracts/releases. */
  function repository() {
    const root = tempDir();
    const dir = join(root, 'contracts', 'releases');
    git(root, 'init', '--quiet', '--initial-branch=main');
    history(dir);
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Releases 1 and 2');
    return { root, dir, since: { ref: 'main', history: gitHistory(root, dir) } };
  }

  /** Release 3: release 2 plus an added operation. */
  function third(dir: string): ReleaseFile {
    const latest = latestReleaseFile(dir)!;
    const ir = structuredClone(latest.ir) as unknown as IrDocument;
    const shop = ir.modules.shop!;
    (shop.operations as Record<string, unknown>).listItems = { ...shop.operations.getItem!, description: 'List items.' };
    return release(latest, ir);
  }

  it('accepts a new release that publish would have written', () => {
    const { dir, since } = repository();
    writeFileSync(join(dir, '000003.json'), formatRelease(third(dir)));
    expect(verifyReleaseFiles(dir, since)).toEqual([]);
  });

  it('rejects an edited or deleted old release, even when the file itself is consistent', () => {
    const { dir, since } = repository();
    edit(join(dir, '000002.json'), (file) => {
      file.release.summary.publishedBy = 'someone else';
    });
    expect(verifyReleaseFiles(dir, since)).toEqual(['000002.json: changed since main; releases are append-only']);

    rmSync(join(dir, '000002.json'));
    expect(verifyReleaseFiles(dir, since)).toContain('000002.json: deleted since main; releases are append-only');
  });

  it('rejects a new release whose recorded changes differ from the checker', () => {
    const { dir, since } = repository();
    const file = third(dir);
    file.release.changes = [];
    writeFileSync(join(dir, '000003.json'), formatRelease(file));
    expect(verifyReleaseFiles(dir, since)).toEqual([
      '000003.json: recorded changes differ from what the compatibility check reports',
    ]);
  });

  it('rejects a new release that breaks clients without a version bump', () => {
    const { dir, since } = repository();
    const latest = latestReleaseFile(dir)!;
    const ir = structuredClone(latest.ir) as unknown as IrDocument;
    delete (ir.modules.shop!.operations as Record<string, unknown>).getItem;
    // Built by hand, as someone skipping `modura publish` would.
    const forged = release(null, ir);
    forged.release.summary.number = 3;
    writeFileSync(join(dir, '000003.json'), formatRelease(forged));

    expect(verifyReleaseFiles(dir, since)).toEqual([
      expect.stringMatching(/^000003\.json: registry\.INCOMPATIBLE_CHANGE: The release breaks clients: /),
    ]);
  });

  it('turns two branches publishing the same release into a merge conflict', () => {
    const { root, dir } = repository();
    git(root, 'checkout', '--quiet', '-b', 'other');
    const theirs = third(dir);
    theirs.release.summary.publishedBy = 'someone else';
    writeFileSync(join(dir, '000003.json'), formatRelease(theirs));
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Release 3 on other');

    git(root, 'checkout', '--quiet', 'main');
    writeFileSync(join(dir, '000003.json'), formatRelease(third(dir)));
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Release 3 on main');

    // The git equivalent of STALE_BASE: rebase, drop your file, publish again.
    let output = '';
    try {
      git(root, 'merge', '--no-edit', 'other');
    } catch (error) {
      output = String((error as { stdout?: string }).stdout);
    }
    expect(output).toContain('CONFLICT (add/add): Merge conflict in contracts/releases/000003.json');
  });
});
