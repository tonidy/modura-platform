/**
 * Runs the Modura MCP server over stdio.
 *
 *   MODURA_API_URL       base URL for every service, default http://localhost:8080
 *   MODURA_SERVICE_URLS  JSON object of base URLs per service, for example
 *                        {"registry-go":"http://localhost:8081"}; default none
 *   MODURA_MCP_TOKEN  bearer token, default the public viewer token "demo-viewer"
 *   MODURA_MCP_TOOLS  tool definitions, default generated/mcp/tools.json in the
 *                     working directory, where `modura generate` writes them
 *
 * stdout carries the MCP protocol, so diagnostics go to stderr.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpTransport } from '@modura/sdk';
import { createServer, loadTools, parseServiceUrls } from './server.ts';

const toolsPath = resolve(process.env.MODURA_MCP_TOOLS ?? 'generated/mcp/tools.json');
const { tools, refused } = loadTools(JSON.parse(readFileSync(toolsPath, 'utf8')));
for (const reason of refused) console.error(`modura-mcp: refused tool ${reason}`);

const api = createHttpTransport({
  baseUrl: process.env.MODURA_API_URL ?? 'http://localhost:8080',
  serviceUrls: parseServiceUrls(process.env.MODURA_SERVICE_URLS ?? '{}'),
  token: process.env.MODURA_MCP_TOKEN ?? 'demo-viewer',
});

await createServer(tools, api).connect(new StdioServerTransport());
console.error(`modura-mcp: serving ${tools.length} read-only tools over stdio`);
