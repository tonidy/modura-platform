import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';
import { query } from './db';

// Plan M5 against the real stack: the Modura CLI publishes through the generated SDK,
// and a real MCP client reads through the MCP server. No browser needed.
test.describe.configure({ mode: 'serial' });

const root = fileURLToPath(new URL('../..', import.meta.url));
const registry = `http://localhost:${process.env.E2E_REGISTRY_PORT ?? '18082'}`;
const publisherToken = process.env.E2E_PUBLISHER_TOKEN ?? 'e2e-publisher-secret';

function modura(args: string[], token: string) {
  const result = spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/main.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MODURA_REGISTRY_URL: registry, MODURA_REGISTRY_TOKEN: token, MODURA_PUBLISHER: 'e2e' },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

async function mcpClient() {
  const transport = new StdioClientTransport({
    command: join(root, 'node_modules/.bin/tsx'),
    args: [join(root, 'apps/mcp-server/src/main.ts')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      MODURA_MCP_TOOLS: join(root, 'generated/mcp/tools.json'),
      MODURA_SERVICE_URLS: JSON.stringify({ 'registry-go': registry }),
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { text: string }[])[0]!.text;
}

test('the CLI publishes the current contract through the generated SDK', async () => {
  const published = modura(['publish'], publisherToken);
  expect(published.output).toContain('Published release 1: registry@0.2.0');
  expect(published.status).toBe(0);

  const [row] = await query<{ number: number; published_by: string }>('SELECT number, published_by FROM registry.contract_releases');
  expect(row).toEqual({ number: 1, published_by: 'publisher' });
});

test('publishing the same contract again is refused, and a viewer cannot publish', () => {
  const again = modura(['publish'], publisherToken);
  expect(again.status).toBe(1);
  expect(again.output).toContain('registry.NOTHING_TO_PUBLISH');

  const viewer = modura(['publish'], 'demo-viewer');
  expect(viewer.status).toBe(1);
  expect(viewer.output).toContain('FORBIDDEN');

  const compat = modura(['compat', '--against', 'registry'], 'demo-viewer');
  expect(compat.output).toContain('Compatible with release 1.');
});

test('a file registry writes the release the server stored, apart from who and when', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modura-releases-'));
  const published = modura(['publish', '--registry', `file:${dir}`], '');
  expect(published.output).toContain('Published release 1: registry@0.2.0');

  const response = await fetch(`${registry}/v1/registry.getRelease`, {
    method: 'POST',
    headers: { authorization: 'Bearer demo-viewer', 'content-type': 'application/json' },
    body: '{}',
  });
  const server = await response.json();
  const file = JSON.parse(readFileSync(join(dir, '000001.json'), 'utf8'));

  const withoutWhoAndWhen = (release: { summary: Record<string, unknown> }) => {
    const { publishedAt: _at, publishedBy: _by, ...summary } = release.summary;
    return { ...release, summary };
  };
  expect(withoutWhoAndWhen(file.release)).toEqual(withoutWhoAndWhen(server.release));
  expect(file.ir).toEqual(server.ir);
  expect(file.release.summary.publishedBy).toBe('e2e');
});

test('an MCP client reads contract history', async () => {
  const client = await mcpClient();
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['registry_getRelease', 'registry_listReleases']);

    const history = await client.callTool({ name: 'registry_listReleases', arguments: {} });
    expect(history.structuredContent).toMatchObject({ releases: [{ number: 1, publishedBy: 'publisher' }] });

    const missing = await client.callTool({ name: 'registry_getRelease', arguments: { number: 99 } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(text(missing))).toMatchObject({ code: 'registry.RELEASE_NOT_FOUND' });
  } finally {
    await client.close();
  }
});
