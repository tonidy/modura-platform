import { build } from 'esbuild';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packages = [
  { dir: 'packages/runtime-contracts', entries: { index: 'src/index.ts' } },
  { dir: 'packages/schema', entries: { index: 'src/index.ts' } },
  { dir: 'packages/sdk', entries: { index: 'src/index.ts' } },
  { dir: 'packages/compiler', entries: { index: 'src/index.ts', 'testing/arbitraries': 'src/testing/arbitraries.ts' } },
  { dir: 'packages/generator-openapi', entries: { index: 'src/index.ts' } },
  { dir: 'packages/generator-sdk-ts', entries: { index: 'src/index.ts' } },
  { dir: 'packages/generator-mcp', entries: { index: 'src/index.ts' } },
  { dir: 'modules/registry', entries: { index: 'src/index.ts' } },
  { dir: 'packages/cli', entries: { config: 'src/config.ts', main: 'src/main.ts' } },
  { dir: 'apps/mcp-server', entries: { server: 'src/server.ts', main: 'src/main.ts' } },
];

for (const item of packages) {
  const packageDir = resolve(root, item.dir);
  const outdir = resolve(packageDir, 'dist');
  await rm(outdir, { recursive: true, force: true });
  // Entries named in the package's `bin` get a shebang, so npm can run them.
  const { bin = {} } = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
  const binOutputs = new Set(Object.values(bin).map((path) => path.replace(/^\.\/dist\/(.+)\.js$/, '$1')));
  const entryPoints = Object.entries(item.entries).map(([out, input]) => ({
    out,
    in: resolve(packageDir, input),
  }));

  for (const isBin of [false, true]) {
    const selected = entryPoints.filter((entry) => binOutputs.has(entry.out) === isBin);
    if (selected.length === 0) continue;
    await build({
      entryPoints: selected,
      outdir,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true,
      logLevel: 'info',
      ...(isBin ? { banner: { js: '#!/usr/bin/env node' } } : {}),
    });
  }

  execFileSync('pnpm', [
    'exec', 'tsc',
    '--ignoreConfig',
    ...Object.values(item.entries).map((entry) => resolve(packageDir, entry)),
    '--target', 'ES2023',
    '--module', 'ESNext',
    '--moduleResolution', 'bundler',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir', outdir,
    '--strict',
    '--skipLibCheck',
    '--verbatimModuleSyntax',
    '--resolveJsonModule',
    '--noEmit', 'false',
    '--allowImportingTsExtensions',
    '--types', 'node',
  ], { cwd: packageDir, stdio: 'inherit' });

  await rewriteDeclarationSpecifiers(outdir);
  console.log(`Built ${item.dir}`);
}

async function rewriteDeclarationSpecifiers(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarationSpecifiers(path);
    } else if (entry.name.endsWith('.d.ts')) {
      const text = await readFile(path, 'utf8');
      const rewritten = text.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
      await writeFile(path, rewritten);
    }
  }
}
