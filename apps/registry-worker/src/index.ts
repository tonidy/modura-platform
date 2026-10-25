import type { ErrorObject } from 'ajv';
import type { SchemaCheck } from '@modura/compiler';
import * as apiChecks from './generated/api-checks.js';
import contract from './generated/contract.json' with { type: 'json' };
import type { Env, PublishOutcome, Release } from './registry.ts';

export { Registry } from './registry.ts';

// The Contract Registry served from a Cloudflare Worker (or celld). It answers the
// same HTTP contract as apps/registry-go, generated/openapi/registry-go.json, so the
// CLI, the SDK and the MCP server work against either. Every request is checked here
// the way the Go contract middleware does it, in the same order: rate limit
// (commands), bearer token, permissions, then the input schema. Storage and the
// publish rules live in the Registry Durable Object.

interface Operation {
  id: string;
  kind: string;
  requires: string[];
  idempotent: boolean;
  check: string;
}

interface Identity {
  name: string;
  permissions: Set<string>;
}

const operations: Record<string, Operation> = contract.operations;
const errors: Record<string, { category: string; retryable: boolean; status: number }> = contract.errors;
const checks = apiChecks as Record<string, SchemaCheck>;

// The largest legitimate body is a registry IR document, tens of kilobytes.
const MAX_REQUEST_BYTES = 1 << 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = `req_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const ctx: Context = { requestId };
    try {
      const response = await route(request, env, ctx);
      response.headers.set('X-Request-Id', requestId);
      return response;
    } catch (err) {
      // Details go to the log, keyed by request ID, never to the client.
      console.error(JSON.stringify({ msg: 'request failed', requestId, path: new URL(request.url).pathname, error: String(err) }));
      return error(ctx, 'INTERNAL', 'An unexpected error occurred.');
    }
  },
} satisfies ExportedHandler<Env>;

interface Context {
  requestId: string;
  operation?: string;
}

async function route(request: Request, env: Env, ctx: Context): Promise<Response> {
  const { pathname } = new URL(request.url);
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

  if (pathname === '/healthz' && request.method === 'GET') {
    const ok = await registry.ping().catch(() => false);
    return json({ status: ok ? 'ok' : 'database unavailable' }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
  }
  const op = operations[pathname];
  if (!op) return new Response('404 page not found\n', { status: 404 });
  if (request.method !== 'POST') return new Response('Method Not Allowed\n', { status: 405 });
  ctx.operation = op.id;

  // Commands are limited per client IP when the IP can be trusted, before the token
  // is checked, as in the Go service. Without a trusted IP they are limited per
  // identity after it, so a forged header gains nothing and a caller without a token
  // cannot use up a publisher's bucket.
  const ip = trustedClientIP(request, env);
  const limitCommand = async (bucket: string, message: string) => {
    if (op.kind !== 'command') return undefined;
    const wait = await registry.takeCommandToken(bucket, Number(env.MODURA_COMMANDS_PER_MIN ?? '30'));
    if (wait === 0) return undefined;
    return error(ctx, 'RATE_LIMITED', message, undefined, { 'Retry-After': String(wait) });
  };

  if (ip) {
    const limited = await limitCommand(`ip:${ip}`, 'Too many requests from this address. Wait a moment and retry.');
    if (limited) return limited;
  }

  const identity = identities(env).get(bearerToken(request));
  if (!identity) return error(ctx, 'UNAUTHENTICATED', 'Send a valid bearer token.');
  if (!ip) {
    const limited = await limitCommand(
      `identity:${identity.name}`,
      `Too many commands from ${identity.name}. Wait a moment and retry.`,
    );
    if (limited) return limited;
  }
  for (const permission of op.requires) {
    if (!identity.permissions.has(permission)) {
      return error(ctx, 'FORBIDDEN', `${op.id} requires ${permission}, which ${identity.name} does not have.`, {
        permission,
      });
    }
  }

  const key = request.headers.get('Idempotency-Key');
  if (op.idempotent && !key) {
    return error(ctx, 'VALIDATION_FAILED', 'header Idempotency-Key: value is required but missing', {
      parameter: 'Idempotency-Key',
    });
  }
  if (op.idempotent && !UUID.test(key!)) {
    return error(ctx, 'VALIDATION_FAILED', 'header Idempotency-Key: must be a UUID', { parameter: 'Idempotency-Key' });
  }
  const text = await readBody(request);
  if (text === undefined) {
    return error(ctx, 'VALIDATION_FAILED', 'Request body: larger than 1 MiB.');
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return error(ctx, 'VALIDATION_FAILED', 'The request body is not valid JSON.');
  }
  const check = checks[op.check]!;
  if (!check(input)) {
    const [first] = check.errors ?? [];
    return first ? validationError(ctx, first) : error(ctx, 'VALIDATION_FAILED', 'The request does not match the operation input schema.');
  }

  switch (op.id) {
    case 'registry.publishRelease': {
      const { ir, basedOn } = input as { ir: unknown; basedOn?: number };
      // RPC result types lose the union's discriminant, so restore it.
      const outcome = (await registry.publish({
        scope: identity.name,
        key: key!,
        ir,
        basedOn,
        publisher: identity.name,
      })) as PublishOutcome;
      if (!outcome.ok) return error(ctx, outcome.code, outcome.message, outcome.details);
      return json(outcome.release, 200, { 'Idempotent-Replayed': String(outcome.replayed) });
    }
    case 'registry.listReleases': {
      const { limit = 20 } = input as { limit?: number };
      return json({ releases: await registry.list(limit) });
    }
    case 'registry.getRelease': {
      const { number } = input as { number?: number };
      const found = await registry.get(number);
      if (!found) {
        const message = number === undefined ? 'Nothing has been published yet.' : `There is no release ${number}.`;
        return error(ctx, 'registry.RELEASE_NOT_FOUND', message);
      }
      // The stored canonical bytes go out unchanged.
      return new Response(`{"release":${JSON.stringify(found.release satisfies Release)},"ir":${found.ir}}\n`, {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    default:
      throw new Error(`operation ${op.id} has no handler`);
  }
}

/**
 * The registry's identities. The cashier and viewer tokens are public on purpose (the
 * POS demo tokens still read the registry); the publisher token is a real secret, and
 * without one there is no publisher at all, so publishing is simply off.
 */
function identities(env: Env): Map<string, Identity> {
  const read = new Set(['registry.read']);
  const map = new Map<string, Identity>([
    [env.MODURA_CASHIER_TOKEN || 'demo-cashier', { name: 'cashier', permissions: read }],
    [env.MODURA_VIEWER_TOKEN || 'demo-viewer', { name: 'viewer', permissions: read }],
  ]);
  if (env.MODURA_PUBLISHER_TOKEN) {
    map.set(env.MODURA_PUBLISHER_TOKEN, {
      name: 'publisher',
      permissions: new Set(['registry.read', 'registry.write']),
    });
  }
  return map;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/**
 * The client IP, only from a header a trusted proxy sets and overwrites:
 * MODURA_CLIENT_IP_HEADER when configured (for example X-Forwarded-For behind the
 * load balancer in front of celld), otherwise CF-Connecting-IP, but only on
 * Cloudflare's edge, which `request.cf.colo` shows. celld passes no client address
 * and leaves CF-Connecting-IP as the client sent it. For a list, the last entry is
 * the one the trusted proxy appended. Undefined means no IP can be trusted.
 */
function trustedClientIP(request: Request, env: Env): string | undefined {
  const onEdge = typeof (request.cf as { colo?: unknown } | undefined)?.colo === 'string';
  const header = env.MODURA_CLIENT_IP_HEADER || (onEdge ? 'CF-Connecting-IP' : undefined);
  if (!header) return undefined;
  return request.headers.get(header)?.split(',').at(-1)?.trim() || undefined;
}

/**
 * The body as text, or undefined when it is larger than MAX_REQUEST_BYTES. Counts
 * bytes, not characters, and stops reading at the limit, like Go's MaxBytesReader,
 * so a chunked body without Content-Length is not buffered whole.
 */
async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_REQUEST_BYTES) return undefined;
  if (!request.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validationError(ctx: Context, err: ErrorObject): Response {
  const field = err.instancePath.split('/').filter(Boolean).join('.');
  const reason = err.message ?? 'is invalid';
  if (!field) return error(ctx, 'VALIDATION_FAILED', `Request body: ${reason}`);
  return error(ctx, 'VALIDATION_FAILED', `${field}: ${reason}`, { field });
}

function error(
  ctx: Context,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  const spec = errors[code];
  if (!spec) throw new Error(`error code ${code} is not in the catalog`);
  const body = {
    code,
    message,
    retryable: spec.retryable,
    requestId: ctx.requestId,
    ...(ctx.operation ? { operation: ctx.operation } : {}),
    ...(details ? { details } : {}),
  };
  return json(body, spec.status, headers);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
