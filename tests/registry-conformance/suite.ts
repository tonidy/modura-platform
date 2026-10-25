import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

// One HTTP contract, two implementations: apps/registry-go and apps/registry-worker
// must answer every request here the same way. Each test starts an empty registry
// through `start`, so implementations differ only in how they are started.

export const tokens = { viewer: 'viewer-token', cashier: 'cashier-token', publisher: 'publisher-token' };

/** Environment for a registry under test: the tokens above and no rate limit. */
export function registryEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MODURA_VIEWER_TOKEN: tokens.viewer,
    MODURA_CASHIER_TOKEN: tokens.cashier,
    MODURA_PUBLISHER_TOKEN: tokens.publisher,
    MODURA_COMMANDS_PER_MIN: '0',
    ...overrides,
  };
}

export interface Registry {
  /** Base URL, without a trailing slash. */
  readonly url: string;
  dispose(): Promise<void>;
}

export type StartRegistry = (env: Record<string, string>) => Promise<Registry>;

const root = join(import.meta.dirname, '../..');
const { viewer, cashier, publisher } = tokens;

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

function expectResult(res: Res, status: number, code = '') {
  expect({ status: res.status, code: res.status === 200 ? '' : res.body.code }, JSON.stringify(res.body)).toEqual({
    status,
    code,
  });
}

export function registryConformance(name: string, start: StartRegistry, enabled = true) {
  let disposers: Registry[] = [];
  afterEach(async () => {
    await Promise.all(disposers.map((registry) => registry.dispose()));
    disposers = [];
  });

  async function startRegistry(overrides: Record<string, string> = {}) {
    const registry = await start(registryEnv(overrides));
    disposers.push(registry);
    const call = async (token: string, operation: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${registry.url}/v1/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, headers: res.headers, body: await res.json() } as Res;
    };
    const publish = (token: string, ir: unknown, basedOn = 0, key = randomUUID()) =>
      call(token, 'registry.publishRelease', basedOn > 0 ? { ir, basedOn } : { ir }, { 'Idempotency-Key': key });
    return { url: registry.url, call, publish };
  }

  describe.runIf(enabled)(`registry conformance: ${name}`, () => {
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
    });

    test('health is open, errors carry request and operation', async () => {
      const { url, call } = await startRegistry();
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect(health.headers.get('Content-Type')).toBe('application/json');
      expect(await health.json()).toEqual({ status: 'ok' });

      const res = await call('', 'registry.listReleases', {});
      expect(res.headers.get('X-Request-Id')).toMatch(/^req_[0-9a-f]{16}$/);
      expect(res.body).toMatchObject({ operation: 'registry.listReleases', requestId: res.headers.get('X-Request-Id') });
    });
  });
}

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
