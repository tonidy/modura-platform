import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { beforeAll } from 'vitest';
import { registryConformance } from './suite.ts';

// apps/registry-go as a real process, with a database of its own per registry.
// Without Postgres the suite is skipped, unless MODURA_REQUIRE_DB is set (as in CI).

const app = join(import.meta.dirname, '../../apps/registry-go');
const adminUrl =
  process.env.DATABASE_URL ??
  `postgres://modura:modura@localhost:${process.env.MODURA_PG_PORT ?? '55433'}/modura?sslmode=disable`;

const reachable = await canConnect(adminUrl);
if (!reachable && process.env.MODURA_REQUIRE_DB) {
  throw new Error(`MODURA_REQUIRE_DB is set but Postgres is not reachable at ${redact(adminUrl)}`);
}

let binary = '';
beforeAll(() => {
  if (!reachable) return;
  binary = join(mkdtempSync(join(tmpdir(), 'registry-go-')), 'registry-api');
  execFileSync('go', ['-C', app, 'build', '-o', binary, './cmd/registry-api'], { stdio: 'inherit' });
}, 180_000);

registryConformance(
  'go',
  async (env) => {
    const database = `registry_conformance_${randomBytes(6).toString('hex')}`;
    await admin((client) => client.query(`CREATE DATABASE ${database}`));
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;

    const port = await freePort();
    const child = spawn(binary, ['serve'], {
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: url.toString(),
        MODURA_MIGRATIONS_DIR: join(app, 'migrations'),
        PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, exited);
    return {
      url: base,
      async dispose() {
        child.kill('SIGTERM');
        await exited;
        await admin((client) => client.query(`DROP DATABASE ${database} WITH (FORCE)`));
      },
    };
  },
  reachable,
);

async function canConnect(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function admin(run: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base: string, exited: Promise<void>): Promise<void> {
  let stopped = false;
  void exited.then(() => (stopped = true));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopped) throw new Error('registry-api exited before it became healthy');
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('registry-api did not become healthy within 10 seconds');
}

function redact(connectionString: string): string {
  const url = new URL(connectionString);
  url.password = '';
  return url.toString();
}
