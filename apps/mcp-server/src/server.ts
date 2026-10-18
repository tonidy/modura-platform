/**
 * MCP server for the Modura tools generated from the IR (plan M5, ADR-0009).
 *
 * It serves generated/mcp/tools.json and executes every call through the Modura SDK
 * transport, so a tool call is an ordinary API request to the service that owns the
 * operation (`modura/service`): authenticated, authorized and validated by that
 * service like any other client.
 *
 * Read-only is enforced twice. Here, tools not marked read-only are never registered.
 * On the server, the MCP token is the viewer's, which holds no write permission, so
 * even a tampered tools.json that relabels a command cannot change anything.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modura/sdk';

export interface ToolDefinition extends Tool {
  readonly _meta: {
    readonly 'modura/operation': string;
    readonly 'modura/requires': readonly string[];
    readonly 'modura/service'?: string;
  };
}

export interface LoadedTools {
  readonly tools: readonly ToolDefinition[];
  /** Tools present in the file but refused, with the reason. */
  readonly refused: readonly string[];
}

/** Validates a parsed tools.json and keeps only well-formed, read-only tools. */
export function loadTools(document: unknown): LoadedTools {
  const entries = (document as { tools?: unknown })?.tools;
  if (!Array.isArray(entries)) throw new Error('tools.json has no "tools" array');

  const tools: ToolDefinition[] = [];
  const refused: string[] = [];
  for (const entry of entries as Record<string, any>[]) {
    const name = typeof entry?.name === 'string' ? entry.name : '(unnamed)';
    if (entry?.annotations?.readOnlyHint !== true) {
      refused.push(`${name}: not marked read-only`);
    } else if (typeof entry?._meta?.['modura/operation'] !== 'string') {
      refused.push(`${name}: no modura/operation`);
    } else if (entry._meta['modura/service'] !== undefined && typeof entry._meta['modura/service'] !== 'string') {
      refused.push(`${name}: modura/service is not a string`);
    } else if (entry?.inputSchema?.type !== 'object') {
      refused.push(`${name}: inputSchema is not an object schema`);
    } else {
      tools.push(entry as ToolDefinition);
    }
  }
  return { tools, refused };
}

/** Reads MODURA_SERVICE_URLS: a JSON object mapping service names to http(s) base URLs. */
export function parseServiceUrls(text: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('MODURA_SERVICE_URLS is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MODURA_SERVICE_URLS must be a JSON object of service name to base URL');
  }
  for (const [service, url] of Object.entries(value)) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new Error(`MODURA_SERVICE_URLS: ${service} needs an http(s) URL`);
    }
  }
  return value as Record<string, string>;
}

export function createServer(tools: readonly ToolDefinition[], api: Transport): Server {
  const server = new Server(
    { name: 'modura', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Read-only access to the Modura POS: the product catalog, live stock, sales reports, and the history of published contract releases. Nothing here can sell, change stock or publish.',
    },
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return errorResult({ code: 'UNKNOWN_TOOL', message: `There is no tool named ${request.params.name}.`, retryable: false });
    }
    const result = await api.call(tool._meta['modura/operation'], request.params.arguments ?? {}, {
      service: tool._meta['modura/service'],
    });
    if (!result.ok) return errorResult(result.error);
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      structuredContent: result.value as Record<string, unknown>,
    };
  });

  return server;
}

/** Canonical Modura errors travel as MCP tool errors, with the same JSON body (ADR-0003). */
function errorResult(error: { code: string; message: string; retryable: boolean }): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error, null, 2) }] };
}
