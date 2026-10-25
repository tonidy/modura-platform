import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_startWorker } from 'wrangler';
import { registryConformance } from './suite.ts';

// apps/registry-worker in workerd, with a fresh Durable Object store per registry.
registryConformance('worker', async (env) => {
  const state = mkdtempSync(join(tmpdir(), 'registry-conformance-'));
  const worker = await unstable_startWorker({
    config: join(import.meta.dirname, '../../apps/registry-worker/wrangler.jsonc'),
    bindings: Object.fromEntries(
      Object.entries(env).map(([name, value]) => [name, { type: 'plain_text' as const, value }]),
    ),
    dev: { server: { port: 0 }, inspector: false, persist: state, logLevel: 'error' },
  });
  await worker.ready;
  const url = (await worker.url).origin;
  return {
    url,
    async dispose() {
      await worker.dispose();
      rmSync(state, { recursive: true, force: true });
    },
  };
});
