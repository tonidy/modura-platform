import type { IrDocument } from './ir.ts';
import { pascalCase } from './ir-utils.ts';

/**
 * Identifiers the generators derive from the IR, so the compiler can reject a
 * contract whose names would collide in generated code (ADR-0010). Generators must
 * use these same rules; the compiler check is only as good as this list.
 */

/** Exported by the SDK runtime, the generated client or every OpenAPI document. */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  // OpenAPI components every document has; also Go types from oapi-codegen.
  'Error',
  'Money',
  // SDK runtime and generated client.
  'CallOptions',
  'HttpTransportOptions',
  'IdempotentCallOptions',
  'JsonValue',
  'ModuraClient',
  'ModuraError',
  'Result',
  'Transport',
]);

/**
 * Suffixes added to an operation's PascalCase name: by the OpenAPI and SDK
 * generators (Input, Output, ErrorCode) and by oapi-codegen for Go (Params,
 * RequestObject, ResponseObject, JSONRequestBody). The bare name is the Go method.
 */
const OPERATION_SUFFIXES = ['', 'Input', 'Output', 'ErrorCode', 'Params', 'RequestObject', 'ResponseObject', 'JSONRequestBody'];

export interface GeneratedName {
  readonly identifier: string;
  /** Where in the contract the identifier comes from, for error messages. */
  readonly source: string;
}

export function generatedNames(ir: IrDocument): GeneratedName[] {
  const out: GeneratedName[] = [];
  for (const name of Object.keys(ir.types)) {
    out.push({ identifier: pascalCase(name), source: `type ${name}` });
  }
  for (const [module, definition] of Object.entries(ir.modules)) {
    for (const operation of Object.keys(definition.operations)) {
      const base = pascalCase(module, operation);
      for (const suffix of OPERATION_SUFFIXES) {
        out.push({ identifier: base + suffix, source: `operation ${module}.${operation}` });
      }
    }
    for (const event of Object.keys(definition.events)) {
      out.push({ identifier: `${pascalCase(module, event)}Event`, source: `event ${module}.${event}` });
    }
  }
  return out;
}
