import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_startWorker } from 'wrangler';
import { afterEach, describe, expect, test } from 'vitest';

// The Go registry's HTTP tests (apps/registry-go/internal/httpapi), run against this
// Worker in workerd with real Durable Object storage. Documents start from the real
// generated IR, so the registry sees exactly what `modura publish` sends.

const root = join(import.meta.dirname, '../../..');
const viewer = 'viewer-token';
const cashier = 'cashier-token';
const publisher = 'publisher-token';

// Miniflare merges a request's cf into its own default, which has a colo, so a
// request without edge fields (as celld sends them) needs colo cleared explicitly.
const NO_EDGE = { colo: null };

type Doc = Record<string, any>;
const currentIR = (): Doc => JSON.parse(readFileSync(join(root, 'generated/ir/modura.ir.json'), 'utf8'));
const edit = (doc: Doc, fn: (d: Doc) => void): Doc => {
  const copy = structuredClone(doc);
  fn(copy);
  return copy;
};
const changeFields = (doc: Doc): Doc => doc.types['registry.Change'].fields;
const withReservedField = (doc: Doc) => {
  changeFields(doc).reserved = { required: false, type: { kind: 'integer' } };
};

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
        MODURA_CASHIER_TOKEN: cashier,
        MODURA_PUBLISHER_TOKEN: publisher,
        MODURA_COMMANDS_PER_MIN: '0',
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
  const publish = (token: string, ir: unknown, basedOn = 0, key = randomUUID()) =>
    call(token, 'registry.publishRelease', basedOn > 0 ? { ir, basedOn } : { ir }, { 'Idempotency-Key': key });
  return { worker, call, publish };
}

function expectResult(res: Res, status: number, code = '') {
  expect({ status: res.status, code: res.status === 200 ? '' : res.body.code }, JSON.stringify(res.body)).toEqual({
    status,
    code,
  });
}

describe('registry worker', () => {
  test('publish lifecycle', async () => {
    const { call, publish } = await startRegistry();
    const base = currentIR();

    expectResult(await call(viewer, 'registry.getRelease', {}), 404, 'registry.RELEASE_NOT_FOUND');

    const first = await publish(publisher, base);
    expectResult(first, 200);
    expect(first.body.summary).toMatchObject({ number: 1, publishedBy: 'publisher' });
    expect(first.body.changes).toEqual([]);

    const got = await call(viewer, 'registry.getRelease', {});
    expectResult(got, 200);
    expect(got.body.ir).toEqual(base);
    const sha = createHash('sha256').update(canonical(base)).digest('hex');
    expect(got.body.release.summary.irSha256).toBe(sha);

    expectResult(await publish(publisher, base, 1), 422, 'registry.NOTHING_TO_PUBLISH');

    const second = await publish(publisher, edit(base, withReservedField), 1);
    expectResult(second, 200);
    // registry.Change is returned by getRelease and publishRelease, so it is reported twice.
    expect(second.body.changes).toEqual([
      { module: 'registry', path: 'registry.getRelease.output.release.changes[].reserved', message: 'field added', severity: 'safe' },
      { module: 'registry', path: 'registry.publishRelease.output.changes[].reserved', message: 'field added', severity: 'safe' },
    ]);

    const list = await call(viewer, 'registry.listReleases', {});
    expect(list.body.releases.map((r: { number: number }) => r.number)).toEqual([2, 1]);
    const old = await call(viewer, 'registry.getRelease', { number: 1 });
    expect(old.body.ir).toEqual(base);
  });

  test('rejects unversioned breaking changes on the server', async () => {
    const { publish } = await startRegistry();
    const base = currentIR();
    expectResult(await publish(publisher, base), 200);

    const breaking = edit(base, (doc) => delete changeFields(doc).message);
    const rejected = await publish(publisher, breaking, 1);
    expectResult(rejected, 422, 'registry.INCOMPATIBLE_CHANGE');
    expect(rejected.body.details.violations).toHaveLength(1);
    expect(rejected.body.details.violations[0]).toMatch(/^registry: breaking changes need a major version bump/);
    expect(rejected.body.details.changes).toEqual([
      { module: 'registry', path: 'registry.getRelease.output.release.changes[].message', message: 'field removed', severity: 'breaking' },
      { module: 'registry', path: 'registry.publishRelease.output.changes[].message', message: 'field removed', severity: 'breaking' },
    ]);

    const bumped = edit(breaking, (doc) => (doc.modules.registry.version = '0.3.0'));
    expectResult(await publish(publisher, bumped, 1), 200);
  });

  test('concurrent publishes from the same base', async () => {
    const { publish } = await startRegistry();
    const base = currentIR();
    expectResult(await publish(publisher, base), 200);

    const stale = await publish(publisher, edit(base, withReservedField), 0);
    expectResult(stale, 409, 'registry.STALE_BASE');
    expect(stale.body.details).toEqual({ latest: 1 });

    const a = edit(base, withReservedField);
    const b = edit(base, (doc) => (changeFields(doc).location = { required: false, type: { kind: 'string' } }));
    const results = await Promise.all([publish(publisher, a, 1), publish(publisher, b, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('registry.STALE_BASE');
  });

  test('publish is idempotent', async () => {
    const { call, publish } = await startRegistry();
    const base = currentIR();
    const key = randomUUID();

    const first = await publish(publisher, base, 0, key);
    const retry = await publish(publisher, base, 0, key);
    expectResult(first, 200);
    expectResult(retry, 200);
    expect(first.headers.get('Idempotent-Replayed')).toBe('false');
    expect(retry.headers.get('Idempotent-Replayed')).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect((await call(viewer, 'registry.listReleases', {})).body.releases).toHaveLength(1);

    const other = await publish(publisher, edit(base, withReservedField), 1, key);
    expectResult(other, 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('authorization and IR validation', async () => {
    const { call, publish } = await startRegistry();
    const base = currentIR();

    expectResult(await call('', 'registry.listReleases', {}), 401, 'UNAUTHENTICATED');
    expectResult(await call('wrong', 'registry.listReleases', {}), 401, 'UNAUTHENTICATED');
    expectResult(await call(cashier, 'registry.listReleases', {}), 200);
    const forbidden = await publish(viewer, base);
    expectResult(forbidden, 403, 'FORBIDDEN');
    expect(forbidden.body.details).toEqual({ permission: 'registry.write' });
    expectResult(await publish(cashier, base), 403, 'FORBIDDEN');

    expectResult(await publish(publisher, edit(base, (doc) => (doc.irVersion = '9.9.9'))), 422, 'registry.INVALID_IR');
    // Pre-1.0 documents can be read (old releases) but not published.
    expectResult(await publish(publisher, edit(base, (doc) => (doc.irVersion = '0.2.0'))), 422, 'registry.INVALID_IR');
    const dangling = edit(base, (doc) => delete doc.types['registry.ReleaseNumber']);
    expectResult(await publish(publisher, dangling), 422, 'registry.INVALID_IR');
    expectResult(await publish(publisher, 'hello'), 422, 'registry.INVALID_IR');
    // A newer 1.x minor may add fields this reader does not know; they are ignored.
    const newerMinor = edit(base, (doc) => {
      doc.irVersion = '1.1.0';
      doc.futureField = { anything: true };
    });
    expectResult(await publish(publisher, newerMinor), 200);
  });

  test('publishing is off without a publisher token', async () => {
    const { publish } = await startRegistry({ MODURA_PUBLISHER_TOKEN: '' });
    expectResult(await publish(publisher, currentIR()), 401, 'UNAUTHENTICATED');
    expectResult(await publish('', currentIR()), 401, 'UNAUTHENTICATED');
  });

  test('input is validated against the contract', async () => {
    const { call } = await startRegistry();
    const missing = await call(publisher, 'registry.publishRelease', { ir: currentIR() });
    expectResult(missing, 400, 'VALIDATION_FAILED');
    expect(missing.body.details).toEqual({ parameter: 'Idempotency-Key' });
    const badKey = await call(publisher, 'registry.publishRelease', { ir: {} }, { 'Idempotency-Key': 'not-a-uuid' });
    expectResult(badKey, 400, 'VALIDATION_FAILED');

    const tooMany = await call(viewer, 'registry.listReleases', { limit: 101 });
    expectResult(tooMany, 400, 'VALIDATION_FAILED');
    expect(tooMany.body.details).toEqual({ field: 'limit' });
    expectResult(await call(viewer, 'registry.getRelease', { number: 1, extra: true }), 400, 'VALIDATION_FAILED');

    // 600,000 characters but 1.2 MB: the limit counts bytes.
    const large = await call(viewer, 'registry.getRelease', { number: 1, pad: 'é'.repeat(600_000) });
    expectResult(large, 400, 'VALIDATION_FAILED');
    expect(large.body.message).toBe('Request body: larger than 1 MiB.');
  });

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

  test('health is open, errors carry request and operation', async () => {
    const { worker, call } = await startRegistry();
    const health = await worker.fetch('http://registry/healthz');
    expect(health.status).toBe(200);
    expect(health.headers.get('Content-Type')).toBe('application/json');
    expect(await health.json()).toEqual({ status: 'ok' });

    const res = await call('', 'registry.listReleases', {});
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_[0-9a-f]{16}$/);
    expect(res.body).toMatchObject({ operation: 'registry.listReleases', requestId: res.headers.get('X-Request-Id') });
  });
});

function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
  );
}
