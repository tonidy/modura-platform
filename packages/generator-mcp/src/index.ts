import { listOperations, type IrDocument, type IrType } from '@modura/compiler';
import {
  moneySchema,
  toJsonSchema,
  type JsonSchema,
  type SchemaResolver,
} from '@modura/generator-openapi';

export interface McpToolDefinition {
  /** MCP tool names allow letters, digits, `_` and `-`, so "inventory.getStock" becomes "inventory_getStock". */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
  readonly _meta: {
    readonly 'modura/operation': string;
    readonly 'modura/requires': readonly string[];
    /** The service that implements the operation, when a service map is given. */
    readonly 'modura/service'?: string;
  };
}

export interface McpOptions {
  /** Module name to the service that implements it (plan M7). */
  readonly services?: Readonly<Record<string, string>>;
}

/**
 * Tool definitions for every operation the IR exposes to MCP. Schemas are fully
 * inlined, since MCP clients cannot follow references into another document.
 *
 * The compiler already rejects MCP exposure on commands. This generator checks again,
 * because a write tool reaching an AI client is the one mistake v1 must not make.
 */
export function generateMcpTools(ir: IrDocument, options: McpOptions = {}): { tools: McpToolDefinition[] } {
  const resolve: SchemaResolver = {
    ref: (name) => {
      const type = ir.types[name];
      if (type === undefined) throw new Error(`IR references undefined type "${name}"`);
      return toJsonSchema(type, resolve);
    },
    money: () => moneySchema,
  };

  const tools = listOperations(ir)
    .filter(({ operation }) => operation.expose.mcp)
    .map(({ id, module, name, operation }): McpToolDefinition => {
      if (operation.kind !== 'query') {
        throw new Error(`${id} is a ${operation.kind}; only queries may become MCP tools in v1`);
      }
      return {
        name: `${module}_${name}`,
        description: operation.description,
        inputSchema: toJsonSchema(operation.input, resolve),
        outputSchema: isObject(operation.output, ir)
          ? toJsonSchema(operation.output, resolve)
          : undefined,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          'modura/operation': id,
          'modura/requires': operation.requires,
          'modura/service': options.services?.[module],
        },
      };
    });

  return { tools };
}

/** MCP requires `outputSchema` to describe an object. */
function isObject(type: IrType, ir: IrDocument): boolean {
  if (type.kind === 'ref') {
    const target = ir.types[type.name];
    return target !== undefined && isObject(target, ir);
  }
  return type.kind === 'object';
}
