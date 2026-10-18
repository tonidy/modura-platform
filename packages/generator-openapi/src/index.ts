import {
  errorDefinition,
  listOperations,
  pascalCase,
  type IrDocument,
  type IrType,
} from '@modura/compiler';
import { httpStatusFor } from '@modura/runtime-contracts';

export type JsonSchema = { readonly [key: string]: unknown };

export interface SchemaResolver {
  /** Schema for a named IR type such as "catalog.ProductId". */
  ref(name: string): JsonSchema;
  /** Schema for the built-in money type. */
  money(): JsonSchema;
}

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  /**
   * Only these modules' operations, for one service's document (plan M7). Event
   * payloads are kept for events those modules publish or subscribe to, and named
   * types only when something kept references them, so a service's document says
   * nothing about modules it does not own. Default: all.
   */
  readonly modules?: readonly string[];
}

/**
 * HTTP convention: every operation is `POST /v1/{module}.{operation}` with a JSON body,
 * in the style of Twirp and Connect. Inputs are typed objects, so there are no URL
 * encoding rules to invent for nested types. See ADR-0002.
 */
export function operationPath(id: string): string {
  return `/v1/${id}`;
}

/** "inventory", "getStock" -> "inventoryGetStock". Go method names derive from this. */
export function operationId(module: string, name: string): string {
  return module + pascalCase(name);
}

export const moneySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amountMinor', 'currency'],
  properties: {
    amountMinor: {
      type: 'integer',
      format: 'int64',
      description: "Amount in the currency's minor unit, for example cents.",
    },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 code.' },
  },
};

export const errorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'retryable'],
  properties: {
    code: {
      type: 'string',
      description: 'Platform code or qualified domain code. Clients match on this, never on message.',
    },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    operation: { type: 'string' },
    requestId: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
};

/**
 * Maps an IR type to a schema that is valid both as OpenAPI 3.0 and as JSON Schema.
 * Descriptions on references are dropped because OpenAPI 3.0 ignores `$ref` siblings.
 */
export function toJsonSchema(type: IrType, resolve: SchemaResolver): JsonSchema {
  switch (type.kind) {
    case 'string':
      return {
        type: 'string',
        description: type.description,
        minLength: type.minLength,
        maxLength: type.maxLength,
        pattern: type.pattern,
      };
    case 'integer':
      return {
        type: 'integer',
        format: 'int64',
        description: type.description,
        minimum: type.minimum,
        maximum: type.maximum,
      };
    case 'boolean':
      return { type: 'boolean', description: type.description };
    case 'timestamp':
      return { type: 'string', format: 'date-time', description: type.description };
    case 'money':
      return resolve.money();
    case 'json':
      // An empty schema accepts any JSON value in both OpenAPI 3.0 and JSON Schema.
      return { description: type.description };
    case 'enum':
      return { type: 'string', enum: [...type.values], description: type.description };
    case 'array':
      return {
        type: 'array',
        description: type.description,
        items: toJsonSchema(type.items, resolve),
        minItems: type.minItems,
        maxItems: type.maxItems,
      };
    case 'object': {
      const required = Object.entries(type.fields)
        .filter(([, field]) => field.required)
        .map(([name]) => name)
        .sort();
      return {
        type: 'object',
        description: type.description,
        additionalProperties: false,
        // OpenAPI 3.0 rejects an empty `required` array.
        required: required.length > 0 ? required : undefined,
        properties: Object.fromEntries(
          Object.entries(type.fields).map(([name, field]) => [
            name,
            toJsonSchema(field.type, resolve),
          ]),
        ),
      };
    }
    case 'ref':
      return resolve.ref(type.name);
  }
}

const componentRef = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: JsonSchema) => ({ 'application/json': { schema } });

export function generateOpenApi(ir: IrDocument, options: OpenApiOptions): JsonSchema {
  const resolve: SchemaResolver = {
    ref: (name) => componentRef(pascalCase(name)),
    money: () => componentRef('Money'),
  };

  const schemas: Record<string, JsonSchema> = {};
  const addSchema = (name: string, schema: JsonSchema) => {
    if (name in schemas) throw new Error(`OpenAPI schema name "${name}" is generated twice`);
    schemas[name] = schema;
  };

  addSchema('Error', errorSchema);
  addSchema('Money', moneySchema);
  for (const [name, type] of Object.entries(ir.types)) {
    addSchema(pascalCase(name), toJsonSchema(type, resolve));
  }

  const included = (module: string) => options.modules === undefined || options.modules.includes(module);

  const paths: Record<string, unknown> = {};
  for (const { id, module, name, operation } of listOperations(ir)) {
    if (!included(module)) continue;
    const base = pascalCase(module, name);
    addSchema(`${base}Input`, toJsonSchema(operation.input, resolve));

    let output: JsonSchema;
    if (operation.output.kind === 'ref') {
      output = resolve.ref(operation.output.name);
    } else {
      addSchema(`${base}Output`, toJsonSchema(operation.output, resolve));
      output = componentRef(`${base}Output`);
    }

    paths[operationPath(id)] = {
      post: {
        operationId: operationId(module, name),
        tags: [module],
        summary: id,
        description: operation.description,
        security: [{ bearerAuth: [] }],
        parameters: operation.idempotent ? [idempotencyKeyParameter] : undefined,
        requestBody: { required: true, content: json(componentRef(`${base}Input`)) },
        responses: {
          '200': {
            description: 'Success.',
            headers: operation.idempotent ? { 'Idempotent-Replayed': replayedHeader } : undefined,
            content: json(output),
          },
          ...errorResponses(ir, operation.errors),
        },
        'x-modura-operation': id,
        'x-modura-kind': operation.kind,
        'x-modura-requires': operation.requires,
        'x-modura-idempotent': operation.idempotent,
      },
    };
  }

  // Event payloads are not part of any request or response, but services need their
  // types. They become components marked with the qualified event name: for the
  // events a service's modules publish, and for the ones they subscribe to.
  const subscribed = new Set(
    Object.entries(ir.modules)
      .filter(([module]) => included(module))
      .flatMap(([, definition]) => definition.subscribes),
  );
  for (const [module, definition] of Object.entries(ir.modules)) {
    for (const [name, event] of Object.entries(definition.events)) {
      if (!included(module) && !subscribed.has(`${module}.${name}`)) continue;
      const payload = event.payload.kind === 'ref' ? ir.types[event.payload.name] : event.payload;
      if (payload === undefined) throw new Error(`${module}.${name}: payload type is undefined`);
      addSchema(`${pascalCase(module, name)}Event`, {
        ...toJsonSchema(payload, resolve),
        description: event.description,
        'x-modura-event': `${module}.${name}`,
      });
    }
  }

  return {
    openapi: '3.0.3',
    info: { title: options.title, version: options.version },
    paths,
    components: {
      schemas: options.modules === undefined ? schemas : reachable(schemas, paths, ir),
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
  };
}

/**
 * Drops the named types nothing references. Every other schema here (Error, Money,
 * operation inputs and outputs, event payloads) was generated for something kept.
 */
function reachable(
  schemas: Record<string, JsonSchema>,
  paths: Record<string, unknown>,
  ir: IrDocument,
): Record<string, JsonSchema> {
  const typeNames = new Set(Object.keys(ir.types).map((name) => pascalCase(name)));
  const keep = new Set(Object.keys(schemas).filter((name) => !typeNames.has(name)));
  const pending: unknown[] = [paths, ...[...keep].map((name) => schemas[name])];
  const prefix = '#/components/schemas/';
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(prefix)) {
        const name = value.slice(prefix.length);
        if (!keep.has(name)) {
          keep.add(name);
          pending.push(schemas[name]);
        }
      } else {
        pending.push(value);
      }
    }
  }
  return Object.fromEntries(Object.entries(schemas).filter(([name]) => keep.has(name)));
}

const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Unique per attempt, for example per checkout. Retrying with the same key returns the original result.',
  schema: { type: 'string', format: 'uuid' },
};

const replayedHeader = {
  description: 'True when this response replays an earlier request with the same idempotency key.',
  schema: { type: 'boolean' },
};

/** One response per HTTP status, listing every error code that maps to it. */
function errorResponses(ir: IrDocument, codes: readonly string[]): Record<string, unknown> {
  const byStatus = new Map<number, string[]>();
  for (const code of codes) {
    const status = httpStatusFor(errorDefinition(ir, code).category);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus].map(([status, statusCodes]) => [
      String(status),
      {
        description: statusCodes.join(', '),
        'x-modura-error-codes': statusCodes,
        content: json(componentRef('Error')),
      },
    ]),
  );
}
