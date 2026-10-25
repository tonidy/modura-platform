import { describe, expect, it, vi } from 'vitest';
import { createHttpTransport } from './runtime.ts';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
}

describe('createHttpTransport', () => {
  it('posts JSON to /v1/{operation} with the bearer token and idempotency key', async () => {
    const fetch = respond(200, { id: 'sale_1' }, { 'idempotent-replayed': 'true' });
    const transport = createHttpTransport({ baseUrl: 'http://api.test/', token: 't0k', fetch });

    const result = await transport.call('sales.createSale', { lines: [] }, { idempotencyKey: 'k-1' });

    expect(result).toEqual({ ok: true, value: { id: 'sale_1' }, replayed: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/v1/sales.createSale');
    expect(init.headers).toMatchObject({ authorization: 'Bearer t0k', 'idempotency-key': 'k-1' });
    expect(init.body).toBe('{"lines":[]}');
  });

  it('returns the server error body as a typed failure', async () => {
    const error = { code: 'FORBIDDEN', message: 'Missing sales.write', retryable: false };
    const transport = createHttpTransport({ baseUrl: 'http://api.test', fetch: respond(403, error) });

    expect(await transport.call('sales.createSale', {})).toEqual({ ok: false, error });
  });

  it('maps network failures and gateway errors to UNAVAILABLE and malformed errors to INTERNAL', async () => {
    const offline = createHttpTransport({
      baseUrl: 'http://api.test',
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const gateway = (status: number) =>
      createHttpTransport({
        baseUrl: 'http://api.test',
        fetch: vi.fn(async () => new Response('<html>Bad Gateway</html>', { status })),
      });
    const garbled = createHttpTransport({ baseUrl: 'http://api.test', fetch: respond(500, 'oops') });

    expect(await offline.call('inventory.getStock', {})).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE', retryable: true },
    });
    for (const status of [429, 502, 503, 504]) {
      expect(await gateway(status).call('inventory.getStock', {})).toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE', retryable: true },
      });
    }
    expect(await garbled.call('inventory.getStock', {})).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', retryable: false },
    });
  });

  it('treats a success without a JSON body as INTERNAL, not as an empty value', async () => {
    for (const body of ['', 'not json']) {
      const transport = createHttpTransport({
        baseUrl: 'http://api.test',
        fetch: vi.fn(async () => new Response(body, { status: 200 })),
      });
      expect(await transport.call('inventory.getStock', {})).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL', retryable: false },
      });
    }
  });

  it('rethrows when the caller aborts while the body is read', async () => {
    const controller = new AbortController();
    const transport = createHttpTransport({
      baseUrl: 'http://api.test',
      fetch: vi.fn(async () => {
        const stream = new ReadableStream({
          start() {
            controller.abort();
          },
          pull(c) {
            c.error(new DOMException('aborted', 'AbortError'));
          },
        });
        return new Response(stream, { status: 200 });
      }),
    });

    await expect(transport.call('inventory.getStock', {}, { signal: controller.signal })).rejects.toThrow();
  });

  it("sends each call to its service's base URL, and the rest to baseUrl", async () => {
    const fetch = respond(200, {});
    const transport = createHttpTransport({
      baseUrl: 'http://go.test',
      serviceUrls: { 'reports-py': 'http://py.test/' },
      fetch,
    });

    await transport.call('reports.dailySummary', {}, { service: 'reports-py' });
    await transport.call('sales.createSale', {}, { service: 'sales-go' });
    await transport.call('catalog.listProducts', {});

    expect(fetch.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      'http://py.test/v1/reports.dailySummary',
      'http://go.test/v1/sales.createSale',
      'http://go.test/v1/catalog.listProducts',
    ]);
  });
});
