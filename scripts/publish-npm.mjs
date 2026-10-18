import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publish = process.argv.includes('--publish');
const provenance = process.env.NPM_PROVENANCE === '1';
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
        const existing = execFileSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'version'], {
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
      const tag = manifest.version.includes('-') ? 'next' : 'latest';
      const args = ['publish', archivePath, '--access', 'public', '--tag', tag];
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
