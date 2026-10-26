/**
 * The file registry (plan M8, ADR-0012): the Contract Registry as a folder of release
 * files committed to git, for projects that want a release history without a server.
 *
 * Each release is one file, `000001.json` and so on, holding exactly what
 * `registry.getRelease` returns, formatted as canonical JSON. Publishing applies the
 * server's rules with the server's error codes and messages. Git supplies the rest:
 * history, the publisher's identity and, through add/add merge conflicts on the same
 * file name, what `STALE_BASE` does on the server. `verifyReleaseFiles` is the
 * enforcement, run by CI on every pull request.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import {
  canonicalJson,
  checkCompatibility,
  compareCodeUnits,
  compile,
  irSha256,
  validateIr,
  type IrDocument,
} from '@modura/compiler';
import { generateOpenApi } from '@modura/generator-openapi';
import { registry } from '@modura/module-registry';
import type {
  RegistryGetReleaseOutput,
  RegistryModuleVersion,
  RegistryReleaseSummary,
} from './generated/registry-client.ts';
import { fail, printReport } from './output.ts';

/** One release file: the same shape `registry.getRelease` returns. */
export type ReleaseFile = RegistryGetReleaseOutput;

export interface Rejection {
  readonly code: string;
  readonly message: string;
}

const FILE_NAME = /^(\d{6})\.json$/;

export function releaseFileName(number: number): string {
  return `${String(number).padStart(6, '0')}.json`;
}

/** The text a release file must contain, byte for byte. */
export function formatRelease(file: ReleaseFile): string {
  return canonicalJson(file);
}

/**
 * The release that publishing `ir` after `latest` would create, or the rejection the
 * server would answer with. Messages match apps/registry-go/internal/store/registry.go.
 */
export function nextRelease(
  latest: ReleaseFile | null,
  ir: unknown,
  publishedBy: string,
  publishedAt: Date,
): { ok: true; file: ReleaseFile } | { ok: false; rejection: Rejection } {
  // The Go registry reads IR 0.2.0 but refuses to publish it, with its own message.
  const version = (ir as { irVersion?: unknown } | null)?.irVersion;
  if (version === '0.2.0') {
    return reject('registry.INVALID_IR', `IR ${version} can still be read, but new releases must use IR 1.x.`);
  }
  const issues = validateIr(ir);
  if (issues.length > 0) {
    return reject('registry.INVALID_IR', `The document is not a valid Modura IR document: ${issues[0]}`);
  }
  const document = ir as IrDocument;

  const sha = irSha256(document);
  let changes: ReleaseFile['release']['changes'] = [];
  if (latest !== null) {
    const number = latest.release.summary.number;
    if (sha === latest.release.summary.irSha256) {
      return reject('registry.NOTHING_TO_PUBLISH', `The document is identical to release ${number}.`);
    }
    const report = checkCompatibility(latest.ir as unknown as IrDocument, document);
    if (report.violations.length > 0) {
      return reject('registry.INCOMPATIBLE_CHANGE', `The release breaks clients: ${report.violations[0]}`);
    }
    changes = report.changes.map(({ module, path, message, severity }) => ({ module, path, message, severity }));
  }

  return {
    ok: true,
    file: {
      release: {
        summary: {
          number: (latest?.release.summary.number ?? 0) + 1,
          publishedAt: publishedAt.toISOString(),
          publishedBy,
          irVersion: document.irVersion,
          irSha256: sha,
          modules: moduleVersions(document),
        },
        changes,
      },
      ir: document as unknown as ReleaseFile['ir'],
    },
  };
}

function reject(code: string, message: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { code, message } };
}

function moduleVersions(ir: IrDocument): RegistryModuleVersion[] {
  return Object.keys(ir.modules)
    .sort(compareCodeUnits)
    .map((name) => ({ name, version: ir.modules[name]!.version }));
}

interface Listing {
  /** Release files in name order. */
  readonly releases: readonly { readonly name: string; readonly number: number; readonly text: string }[];
  /** Anything else in the folder. */
  readonly strays: readonly string[];
}

function listReleases(dir: string): Listing {
  if (!existsSync(dir)) return { releases: [], strays: [] };
  const releases: { name: string; number: number; text: string }[] = [];
  const strays: string[] = [];
  for (const name of readdirSync(dir).sort(compareCodeUnits)) {
    const match = FILE_NAME.exec(name);
    if (match) releases.push({ name, number: Number(match[1]), text: readFileSync(join(dir, name), 'utf8') });
    else strays.push(name);
  }
  return { releases, strays };
}

/** The latest release in `dir`, or null when nothing has been published. */
export function latestReleaseFile(dir: string): ReleaseFile | null {
  const last = listReleases(dir).releases.at(-1);
  return last === undefined ? null : (JSON.parse(last.text) as ReleaseFile);
}

/** Up to `limit` release summaries in `dir`, newest first, as `registry.listReleases` returns them. */
export function releaseSummaries(dir: string, limit: number): RegistryReleaseSummary[] {
  return listReleases(dir)
    .releases.toReversed()
    .slice(0, limit)
    .map((r) => (JSON.parse(r.text) as ReleaseFile).release.summary);
}

/** Who publishes: MODURA_PUBLISHER, then `git config user.name`. Never an email address. */
export function publisherName(cwd: string): string {
  const fromEnv = process.env.MODURA_PUBLISHER?.trim();
  if (fromEnv) return fromEnv;
  try {
    const name = execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (name) return name;
  } catch {
    // No git, or no name configured: the error below says what to set.
  }
  return fail('Set MODURA_PUBLISHER or `git config user.name` to say who publishes this release.');
}

export function publishToFiles(ir: IrDocument, dir: string, displayDir: string, publishedBy: string): void {
  const latest = latestReleaseFile(dir);
  if (latest) {
    console.log(`Comparing with release ${latest.release.summary.number}.`);
    printReport(checkCompatibility(latest.ir as unknown as IrDocument, ir));
  } else {
    console.log('Nothing published yet; this will be release 1.');
  }

  const result = nextRelease(latest, ir, publishedBy, new Date());
  if (!result.ok) fail(`Publish rejected: ${result.rejection.code}\n  ${result.rejection.message}`);

  const { summary } = result.file.release;
  const name = releaseFileName(summary.number);
  mkdirSync(dir, { recursive: true });
  // 'wx' never overwrites: once written, a release file is history.
  writeFileSync(join(dir, name), formatRelease(result.file), { flag: 'wx' });
  console.log(`Published release ${summary.number}: ${summary.modules.map((m) => `${m.name}@${m.version}`).join(', ')}`);
  console.log(`Commit ${join(displayDir, name)} to make it part of the history.`);
}

export function compatAgainstFiles(ir: IrDocument, dir: string): void {
  const latest = latestReleaseFile(dir);
  if (!latest) {
    console.log('Nothing published yet, so there is nothing to compare against.');
    return;
  }
  const report = checkCompatibility(latest.ir as unknown as IrDocument, ir);
  printReport(report);
  if (report.violations.length > 0) fail(report.violations.join('\n'));
  console.log(`Compatible with release ${latest.release.summary.number}.`);
}

/** The release folder as it was at a git ref. */
export interface History {
  /** File names in the folder at `ref`; empty if the folder did not exist there. */
  names(ref: string): string[];
  show(ref: string, name: string): string;
}

/** Reads the release folder from git. `root` must exist; `dir` need not, yet. */
export function gitHistory(root: string, dir: string): History {
  const folder = relative(root, dir).split(sep).join('/');
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    names(ref) {
      try {
        git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      } catch {
        return fail(`Unknown git ref: ${ref}`);
      }
      // Paths come back relative to `root`, so keep only the file names.
      return git(['ls-tree', '--name-only', ref, '--', `${folder}/`])
        .split('\n')
        .filter((line) => line !== '')
        .map((path) => path.slice(path.lastIndexOf('/') + 1));
    },
    show: (ref, name) => git(['show', `${ref}:./${folder}/${name}`]),
  };
}

/**
 * Every problem with the release folder, or none. Each file is checked on its own;
 * with `since`, files that existed at that ref must be unchanged, and files added
 * since then must be what `modura publish` would have written. Older releases are
 * never judged again, because the compatibility rules may have become stricter.
 */
export function verifyReleaseFiles(dir: string, since?: { ref: string; history: History }): string[] {
  const issues: string[] = [];
  const { releases, strays } = listReleases(dir);
  for (const stray of strays) issues.push(`${stray}: not a release file (expected names like 000001.json)`);

  const parsed = new Map<number, ReleaseFile>();
  releases.forEach(({ name, number, text }, index) => {
    if (number !== index + 1) {
      issues.push(`${name}: expected ${releaseFileName(index + 1)}; release numbers start at 1 with no gaps`);
    }
    const fileIssues = checkFile(number, text);
    issues.push(...fileIssues.map((issue) => `${name}: ${issue}`));
    if (fileIssues.length === 0) parsed.set(number, JSON.parse(text) as ReleaseFile);
  });

  if (since !== undefined) {
    const before = since.history.names(since.ref).filter((name) => FILE_NAME.test(name));
    const now = new Map(releases.map((r) => [r.name, r.text]));
    for (const name of before) {
      const text = now.get(name);
      if (text === undefined) issues.push(`${name}: deleted since ${since.ref}; releases are append-only`);
      else if (text !== since.history.show(since.ref, name)) {
        issues.push(`${name}: changed since ${since.ref}; releases are append-only`);
      }
    }
    const existed = new Set(before);
    for (const { name, number } of releases) {
      if (existed.has(name)) continue;
      const file = parsed.get(number);
      if (file === undefined || issues.some((issue) => issue.startsWith(`${name}: `))) continue; // Already reported.
      const previous = number === 1 ? null : parsed.get(number - 1);
      if (previous === undefined) {
        issues.push(`${name}: release ${number - 1} is missing or invalid, so this release cannot be checked`);
        continue;
      }
      issues.push(...checkAdded(previous, file).map((issue) => `${name}: ${issue}`));
    }
  }
  return issues;
}

function checkFile(number: number, text: string): string[] {
  let file: ReleaseFile;
  try {
    file = JSON.parse(text) as ReleaseFile;
  } catch (error) {
    return [`not valid JSON (${(error as Error).message})`];
  }
  const schema = releaseSchema();
  if (!schema(file)) {
    return (schema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  }
  if (formatRelease(file) !== text) {
    return ['not in canonical form; release files are written by `modura publish`, never by hand'];
  }

  const issues: string[] = [];
  const { summary, changes } = file.release;
  if (summary.number !== number) issues.push(`summary.number is ${summary.number}, but the file name says ${number}`);
  if (Number.isNaN(Date.parse(summary.publishedAt))) issues.push('summary.publishedAt is not a timestamp');
  const irIssues = validateIr(file.ir);
  if (irIssues.length > 0) return [...issues, ...irIssues.map((issue) => `ir ${issue}`)];

  const ir = file.ir as unknown as IrDocument;
  const sha = irSha256(ir);
  if (summary.irSha256 !== sha) issues.push(`summary.irSha256 does not match the IR (expected ${sha})`);
  if (summary.irVersion !== ir.irVersion) {
    issues.push(`summary.irVersion is ${summary.irVersion}, but the IR says ${ir.irVersion}`);
  }
  if (canonicalJson(summary.modules) !== canonicalJson(moduleVersions(ir))) {
    issues.push('summary.modules does not match the module versions in the IR');
  }
  if (number === 1 && changes.length > 0) issues.push('the first release cannot record changes');
  return issues;
}

/** The checks `modura publish` ran when it wrote `file` after `previous`. */
function checkAdded(previous: ReleaseFile | null, file: ReleaseFile): string[] {
  const { summary } = file.release;
  const result = nextRelease(previous, file.ir, summary.publishedBy, new Date(summary.publishedAt));
  if (!result.ok) return [`${result.rejection.code}: ${result.rejection.message}`];
  if (canonicalJson(result.file.release.changes) !== canonicalJson(file.release.changes)) {
    return ['recorded changes differ from what the compatibility check reports'];
  }
  return [];
}

let validator: ValidateFunction | undefined;

/**
 * The file format is the registry contract's own `getRelease` output, so the schema
 * comes from compiling the registry module rather than from a hand-written copy.
 */
function releaseSchema(): ValidateFunction {
  if (validator === undefined) {
    const document = generateOpenApi(compile([registry]), { title: 'registry', version: '0', modules: ['registry'] });
    const ajv = new Ajv({ strict: false, logger: false, validateFormats: false });
    ajv.addSchema(document, 'registry');
    validator = ajv.getSchema('registry#/components/schemas/RegistryGetReleaseOutput')!;
  }
  return validator;
}
