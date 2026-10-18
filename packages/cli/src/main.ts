/**
 * Thin Modura CLI.
 *
 *   modura generate                    compile the IR and write every generated artifact
 *   modura generate --check            fail if any checked-in artifact is stale (CI)
 *   modura generate --allow-breaking   write even if the change breaks clients
 *   modura generate --strict           fail on compiler warnings (pnpm verify uses this)
 *   modura compat --against <git-ref>  compare the current contract with the IR at a git ref
 *   modura compat --against registry   compare with the latest release in the Contract Registry
 *   modura publish                     publish the current contract to the Contract Registry
 *   modura registry verify             check a file registry for gaps, edits and bad releases
 *
 * Registry commands take --registry <target> (default $MODURA_REGISTRY_URL, then
 * `registry` in modura.config.ts, then http://localhost:8080). A target is either a
 * server URL or `file:<dir>`, a folder of release files committed to git (ADR-0012).
 * Servers read the bearer token from $MODURA_REGISTRY_TOKEN: publishing needs a
 * publisher token, comparing works with the public viewer token. File registries
 * need no token; `registry verify --since <git-ref>` also checks they are append-only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  checkCompatibility,
  compileWithWarnings,
  CompileError,
  irSha256,
  type IrDocument,
} from '@modura/compiler';
import { generateMcpTools } from '@modura/generator-mcp';
import { generateOpenApi } from '@modura/generator-openapi';
import { generateSdk } from '@modura/generator-sdk-ts';
import { serviceOfModule, type ModuraConfig } from './config.ts';
import {
  compatAgainstFiles,
  gitHistory,
  publisherName,
  publishToFiles,
  verifyReleaseFiles,
} from './file-registry.ts';
import { fail, printReport } from './output.ts';
import { compatAgainstRegistry, publish } from './registry.ts';

const usage = `Usage:
  modura generate [--check] [--allow-breaking] [--strict]
  modura compat --against <git-ref | registry> [--registry <url | file:dir>]
  modura publish [--registry <url | file:dir>]
  modura registry verify [--registry file:dir] [--since <git-ref>]`;

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...flags] = argv;
  const root = findWorkspaceRoot(process.cwd());
  const config = (await import(pathToFileURL(join(root, 'modura.config.ts')).href))
    .default as ModuraConfig;

  switch (command) {
    case 'generate':
      return generate(root, config, {
        check: flags.includes('--check'),
        allowBreaking: flags.includes('--allow-breaking'),
        strict: flags.includes('--strict'),
      });
    case 'compat': {
      const ref = flagValue(flags, '--against');
      if (ref === undefined) throw new UsageError(usage);
      if (ref !== 'registry') return compat(root, config, ref);
      const target = registryTarget(root, config, flags);
      const ir = compileCanonical(config, false);
      if (target.kind === 'files') return compatAgainstFiles(ir, target.dir);
      return compatAgainstRegistry(ir, { url: target.url, token: registryToken('demo-viewer') });
    }
    case 'publish': {
      const target = registryTarget(root, config, flags);
      const ir = compileCanonical(config, flags.includes('--strict'));
      if (target.kind === 'files') return publishToFiles(ir, target.dir, display(root, target.dir), publisherName(root));
      return publish(ir, { url: target.url, token: registryToken(undefined) });
    }
    case 'registry': {
      if (flags[0] !== 'verify') throw new UsageError(usage);
      const target = registryTarget(root, config, flags);
      if (target.kind !== 'files') throw new UsageError('registry verify checks a file registry; pass --registry file:<dir>.');
      return verifyFiles(root, target.dir, flagValue(flags, '--since'));
    }
    default:
      throw new UsageError(usage);
  }
}

function flagValue(flags: readonly string[], name: string): string | undefined {
  const index = flags.indexOf(name);
  return index === -1 ? undefined : flags[index + 1];
}

type RegistryTarget = { kind: 'server'; url: string } | { kind: 'files'; dir: string };

function registryTarget(root: string, config: ModuraConfig, flags: readonly string[]): RegistryTarget {
  const target =
    flagValue(flags, '--registry') ?? process.env.MODURA_REGISTRY_URL ?? config.registry ?? 'http://localhost:8080';
  if (target.startsWith('file:')) {
    const dir = target.slice('file:'.length);
    if (dir === '') throw new UsageError('A file registry needs a folder, for example file:contracts/releases.');
    return { kind: 'files', dir: resolve(root, dir) };
  }
  if (!/^https?:\/\//.test(target)) throw new UsageError(`Unknown registry ${target}: use http(s)://... or file:<dir>.`);
  return { kind: 'server', url: target };
}

/** A folder relative to the workspace when it is inside it, absolute otherwise. */
function display(root: string, dir: string): string {
  const path = relative(root, dir);
  return path === '' || path.startsWith('..') ? dir : path;
}

function registryToken(defaultToken: string | undefined): string {
  const token = process.env.MODURA_REGISTRY_TOKEN ?? defaultToken;
  if (token === undefined) throw new UsageError('Set MODURA_REGISTRY_TOKEN to a publisher token to publish.');
  return token;
}

function verifyFiles(root: string, dir: string, since: string | undefined): void {
  const issues = verifyReleaseFiles(dir, since === undefined ? undefined : { ref: since, history: gitHistory(root, dir) });
  const where = display(root, dir);
  if (issues.length > 0) fail([`${where} has ${issues.length} problem(s):`, ...issues.map((i) => `  ✗ ${i}`)].join('\n'));
  console.log(`${where} is a valid release history${since === undefined ? '' : ` and append-only since ${since}`}.`);
}

function generate(
  root: string,
  config: ModuraConfig,
  options: { check: boolean; allowBreaking: boolean; strict: boolean },
): void {
  const ir = compileCanonical(config, options.strict);
  const services = serviceOfModule(config);
  const artifacts = [
    { path: config.outputs.ir, content: canonicalJson(ir) },
    // The canonical hash next to the IR; the Go registry must compute the same value.
    { path: config.outputs.ir.replace(/\.json$/, '.sha256'), content: `${irSha256(ir)}\n` },
    // One OpenAPI document per service, so each implements only its own operations.
    ...Object.entries(config.services).map(([service, { modules, openapi }]) => ({
      path: openapi,
      content: canonicalJson(
        generateOpenApi(ir, { title: `${config.api.title}: ${service}`, version: config.api.version, modules }),
      ),
    })),
    { path: config.outputs.mcp, content: canonicalJson(generateMcpTools(ir, { services })) },
    { path: config.outputs.sdk, content: generateSdk(ir, { services }) },
  ];

  if (options.check) {
    const stale = artifacts.filter((a) => readOrNull(join(root, a.path)) !== a.content);
    if (stale.length > 0) {
      fail(
        ['Generated files are stale:', ...stale.map((a) => `  ${a.path}`), 'Run `pnpm generate` and commit the result.'].join('\n'),
      );
    }
    console.log(`${artifacts.length} generated files are up to date.`);
    return;
  }

  // Guard against accidental breaking changes before overwriting the old contract.
  const previous = readOrNull(join(root, config.outputs.ir));
  if (previous !== null) {
    const report = checkCompatibility(JSON.parse(previous) as IrDocument, ir);
    printReport(report);
    if (report.violations.length > 0 && !options.allowBreaking) {
      fail(
        [
          ...report.violations,
          'Bump the module version, or pass --allow-breaking if you really mean it.',
        ].join('\n'),
      );
    }
  }

  for (const artifact of artifacts) {
    const target = join(root, artifact.path);
    if (readOrNull(target) === artifact.content) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.content);
    console.log(`wrote ${artifact.path}`);
  }
}

function compat(root: string, config: ModuraConfig, ref: string): void {
  let previous: string;
  try {
    previous = execFileSync('git', ['show', `${ref}:${config.outputs.ir}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    console.log(`No IR at ${ref}, so there is nothing to compare against.`);
    return;
  }

  const report = checkCompatibility(JSON.parse(previous) as IrDocument, compileCanonical(config, false));
  printReport(report);
  if (report.violations.length > 0) fail(report.violations.join('\n'));
  console.log(`Compatible with ${ref}.`);
}

/**
 * Generators read the IR as it is serialized, so source declaration order never
 * leaks into output. Warnings are printed; with `strict` they fail the command.
 */
function compileCanonical(config: ModuraConfig, strict: boolean): IrDocument {
  try {
    const { ir, warnings } = compileWithWarnings(config.modules);
    for (const warning of warnings) console.log(`warning: ${warning.path}: ${warning.message}`);
    if (strict && warnings.length > 0) fail(`--strict: ${warnings.length} warning(s) found.`);
    return JSON.parse(canonicalJson(ir)) as IrDocument;
  } catch (error) {
    if (error instanceof CompileError) fail(error.message);
    throw error;
  }
}

function findWorkspaceRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'modura.config.ts'))) return dir;
    if (dirname(dir) === dir) throw new UsageError('No modura.config.ts found in this or any parent directory.');
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) fail(error.message);
  throw error;
});
