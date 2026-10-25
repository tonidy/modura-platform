import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_startWorker } from 'wrangler';
import { afterEach, describe, expect, test } from 'vitest';

// What only the Worker does: rate limiting by the client IP that Cloudflare's edge, a
// configured proxy header, or nothing (celld) provides. The HTTP contract it shares
// with apps/registry-go is tested against both in tests/registry-conformance.

const viewer = 'viewer-token';
const publisher = 'publisher-token';

// Miniflare merges a request's cf into its own default, which has a colo, so a
// request without edge fields (as celld sends them) needs colo cleared explicitly.
const NO_EDGE = { colo: null };

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.map((d) => d()));
  disposers = [];
});

async function startRegistry(vars: Record<string, string> = {}) {
  const state = mkdtempSync(join(tmpdir(), 'registry-worker-'));
  const worker = await unstable_startWorker({
    config: join(import.meta.dirname, '../wrangler.jsonc'),
    bindings: Object.fromEntries(
      Object.entries({
        MODURA_VIEWER_TOKEN: viewer,
        MODURA_PUBLISHER_TOKEN: publisher,
        ...vars,
      }).map(([name, value]) => [name, { type: 'plain_text' as const, value }]),
    ),
    dev: { server: { port: 0 }, inspector: false, persist: state, logLevel: 'error' },
  });
  await worker.ready;
  disposers.push(async () => {
    await worker.dispose();
    rmSync(state, { recursive: true, force: true });
  });

  // cf stands in for request.cf: { colo } as on Cloudflare's edge, NO_EDGE as on celld.
  const call = async (
    token: string,
    operation: string,
    body: unknown,
    headers: Record<string, string> = {},
    cf: Record<string, unknown> = { colo: 'LHR' },
  ) => {
    const res = await worker.fetch(`http://registry/v1/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
      cf,
    });
    return { status: res.status, headers: res.headers as unknown as Headers, body: await res.json() } as Res;
  };
  return { call };
}

function expectResult(res: Res, status: number, code = '') {
  expect({ status: res.status, code: res.status === 200 ? '' : res.body.code }, JSON.stringify(res.body)).toEqual({
    status,
    code,
  });
}

describe('registry worker rate limiting', () => {
  test('without a trusted client IP, commands are limited per identity', async () => {
    // As on celld: no request.cf.colo and no MODURA_CLIENT_IP_HEADER.
    const { call } = await startRegistry({ MODURA_COMMANDS_PER_MIN: '1' });
    const publish = (token: string, ip: string) =>
      call(token, 'registry.publishRelease', { ir: 'hello' }, { 'Idempotency-Key': randomUUID(), 'CF-Connecting-IP': ip }, NO_EDGE);

    // Callers without a token never reach the limiter, so they cannot drain it.
    for (let i = 0; i < 10; i++) expectResult(await publish('wrong', '203.0.113.7'), 401, 'UNAUTHENTICATED');
    // A forged CF-Connecting-IP per request does not give a fresh bucket.
    for (let i = 0; i < 5; i++) expectResult(await publish(publisher, `198.51.100.${i}`), 422, 'registry.INVALID_IR');
    const limited = await publish(publisher, '192.0.2.1');
    expectResult(limited, 429, 'RATE_LIMITED');
    expect(limited.body.message).toBe('Too many commands from publisher. Wait a moment and retry.');
  });

  test('a configured client IP header is trusted, last entry first', async () => {
    const { call } = await startRegistry({ MODURA_COMMANDS_PER_MIN: '1', MODURA_CLIENT_IP_HEADER: 'X-Forwarded-For' });
    const publish = (forwardedFor: string) =>
      call(publisher, 'registry.publishRelease', { ir: 'hello' }, { 'Idempotency-Key': randomUUID(), 'X-Forwarded-For': forwardedFor }, NO_EDGE);

    // The client controls the first entries; the proxy appended the last one.
    for (let i = 0; i < 5; i++) expectResult(await publish(`10.0.0.${i}, 203.0.113.7`), 422, 'registry.INVALID_IR');
    expectResult(await publish('10.9.9.9, 203.0.113.7'), 429, 'RATE_LIMITED');
    expectResult(await publish('203.0.113.7, 198.51.100.4'), 422, 'registry.INVALID_IR');
  });

  test('commands are rate limited per client IP on the edge', async () => {
    // One command a minute gives a burst of 5 and no refill during the test.
    const { call } = await startRegistry({ MODURA_COMMANDS_PER_MIN: '1' });
    const publish = (ip: string) =>
      call(publisher, 'registry.publishRelease', { ir: 'hello' }, { 'Idempotency-Key': randomUUID(), 'CF-Connecting-IP': ip });

    for (let i = 0; i < 5; i++) expectResult(await publish('203.0.113.7'), 422, 'registry.INVALID_IR');
    const limited = await publish('203.0.113.7');
    expectResult(limited, 429, 'RATE_LIMITED');
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.body.retryable).toBe(true);

    // Another client has its own bucket, and queries are never limited.
    expectResult(await publish('198.51.100.4'), 422, 'registry.INVALID_IR');
    for (let i = 0; i < 5; i++) {
      expectResult(await call(viewer, 'registry.listReleases', {}, { 'CF-Connecting-IP': '203.0.113.7' }), 200);
    }
  });
});
