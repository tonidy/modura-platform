import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modura/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createServer, loadTools, parseServiceUrls } from './server.ts';

const generated = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../generated/mcp/tools.json', import.meta.url)), 'utf8'),
);

async function connect(document: unknown, api: Transport) {
  const { tools } = loadTools(document);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(tools, api).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

/** A stand-in for the SDK transport that answers every call with `result`. */
function fakeApi(result: unknown) {
  const call = vi.fn(async (_operation: string, _input: unknown, _options?: unknown) => result);
  return Object.assign({ call } as unknown as Transport, { calls: call });
}

describe('Modura MCP server', () => {
  it('lists exactly the generated read-only tools', async () => {
    const client = await connect(generated, fakeApi({ ok: true, value: {}, replayed: false }));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'registry_getRelease',
      'registry_listReleases',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('executes a call as the matching Modura operation', async () => {
    const releases = { releases: [{ number: 1, publishedBy: 'someone' }] };
    const api = fakeApi({ ok: true, value: releases, replayed: false });
    const client = await connect(generated, api);

    const result = await client.callTool({ name: 'registry_listReleases', arguments: {} });

    expect(api.calls).toHaveBeenCalledWith('registry.listReleases', {}, { service: 'registry-go' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(releases);
  });

  it('returns canonical errors as tool errors', async () => {
    const error = { code: 'registry.RELEASE_NOT_FOUND', message: 'No release has this number.', retryable: false };
    const client = await connect(generated, fakeApi({ ok: false, error }));

    const result = await client.callTool({ name: 'registry_getRelease', arguments: { number: 99 } });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(error);
  });

  it('never registers a tool that is not marked read-only, even from a tampered file', async () => {
    const tampered = {
      tools: [
        ...generated.tools,
        {
          name: 'registry_publishRelease',
          description: 'Publish a release.',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: false },
          _meta: { 'modura/operation': 'registry.publishRelease', 'modura/requires': ['registry.write'] },
        },
      ],
    };
    expect(loadTools(tampered).refused).toEqual(['registry_publishRelease: not marked read-only']);

    const api = fakeApi({ ok: true, value: {}, replayed: false });
    const client = await connect(tampered, api);
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'registry_publishRelease', arguments: {} });

    expect(tools.map((t) => t.name)).not.toContain('registry_publishRelease');
    expect(result.isError).toBe(true);
    expect(api.calls).not.toHaveBeenCalled();
  });

  it('sends each call to the service that owns the operation', async () => {
    const api = fakeApi({ ok: true, value: {}, replayed: false });
    const client = await connect(generated, api);

    await client.callTool({ name: 'registry_getRelease', arguments: { number: 1 } });

    expect(api.calls).toHaveBeenCalledWith('registry.getRelease', { number: 1 }, { service: 'registry-go' });
  });

  it('accepts only a JSON object of http(s) URLs for MODURA_SERVICE_URLS', () => {
    expect(parseServiceUrls('{"registry-go":"http://localhost:8090"}')).toEqual({ 'registry-go': 'http://localhost:8090' });
    expect(() => parseServiceUrls('registry-go=http://x')).toThrow(/not valid JSON/);
    expect(() => parseServiceUrls('["http://x"]')).toThrow(/JSON object/);
    expect(() => parseServiceUrls('{"registry-go":"file:///etc/passwd"}')).toThrow(/registry-go needs an http/);
  });
});
