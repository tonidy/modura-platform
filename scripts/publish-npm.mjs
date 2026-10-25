import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publish = process.argv.includes('--publish');
const provenance = process.env.NPM_PROVENANCE === '1';
// Development builds (publish-dev.yml) go to another registry under their own
// dist-tag, with a suffix that makes each version unique: 1.0.0-rc.4.dev.12.g1a2b3c4.
const registry = process.env.NPM_REGISTRY;
const forcedTag = process.env.NPM_DIST_TAG;
const versionSuffix = process.env.NPM_VERSION_SUFFIX;
const registryArgs = registry ? ['--registry', registry] : [];
const packages = [
  'packages/runtime-contracts',
  'packages/schema',
  'packages/sdk',
  'packages/compiler',
  'packages/generator-openapi',
  'packages/generator-sdk-ts',
  'packages/generator-mcp',
  'modules/registry',
  'packages/cli',
  'apps/mcp-server',
];
const releaseTag = process.env.GITHUB_REF_NAME;
if (provenance && releaseTag) {
  const taggedVersion = releaseTag.replace(/^npm-v/, '');
  for (const relative of packages) {
    const manifest = JSON.parse(await readFile(resolve(root, relative, 'package.json'), 'utf8'));
    if (manifest.version !== taggedVersion) {
      throw new Error(`${manifest.name} is ${manifest.version}, but tag ${releaseTag} expects ${taggedVersion}`);
    }
  }
}
if (versionSuffix) {
  // Rewrites the manifests in place, before any pack, so `workspace:` ranges resolve
  // to the suffixed versions too. Meant for CI checkouts, not a working tree.
  for (const relative of packages) {
    const path = resolve(root, relative, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.version += `${manifest.version.includes('-') ? '.' : '-'}${versionSuffix}`;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
const destination = await mkdtemp(resolve(tmpdir(), 'modura-npm-'));

try {
  for (const relative of packages) {
    const packageDir = resolve(root, relative);
    const manifest = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
    const entriesBefore = new Set(await readdir(destination));
    execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: packageDir, stdio: 'inherit' });
    const archive = (await readdir(destination)).find((name) => name.endsWith('.tgz') && !entriesBefore.has(name));
    if (!archive) throw new Error(`pnpm pack produced no tarball for ${manifest.name}`);
    const archivePath = resolve(destination, archive);
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], { encoding: 'utf8' }));
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      throw new Error(`packed metadata mismatch for ${manifest.name}`);
    }
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(packed[section] ?? {})) {
        if (version.startsWith('workspace:')) {
          throw new Error(`${manifest.name} still has ${name}:${version} in its npm tarball`);
        }
      }
    }
    if (publish) {
      try {
        const existing = execFileSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'version', ...registryArgs], {
          cwd: packageDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (existing === manifest.version) {
          console.log(`Already published ${manifest.name}@${manifest.version}; skipping immutable version.`);
          continue;
        }
      } catch (error) {
        const stderr = error.stderr?.toString() ?? '';
        if (!stderr.includes('E404')) throw error;
      }
    }
    console.log(`${publish ? 'Publishing' : 'Packed'} ${manifest.name}@${manifest.version}: ${archivePath}`);
    if (publish) {
      const tag = distTag(manifest, packageDir);
      const args = ['publish', archivePath, '--access', 'public', '--tag', tag, ...registryArgs];
      if (provenance) args.push('--provenance');
      execFileSync('npm', args, { cwd: packageDir, stdio: 'inherit' });
    }
  }
  if (!publish) {
    console.log('Dry run only. Inspect the tarballs above; pass --publish to publish them to npm.');
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}

// A prerelease goes to `next` only once a stable version holds `latest`. Until then
// it takes `latest`, so `npm install @modura/cli` gets the newest release candidate.
function distTag(manifest, packageDir) {
  if (forcedTag) return forcedTag;
  if (!manifest.version.includes('-')) return 'latest';
  let latest = '';
  try {
    latest = execFileSync('npm', ['view', manifest.name, 'dist-tags.latest', ...registryArgs], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString() ?? '';
    if (!stderr.includes('E404')) throw error;
  }
  return latest && !latest.includes('-') ? 'next' : 'latest';
}
