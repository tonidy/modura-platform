import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from './ir.schema.json' with { type: 'json' };
import type { IrDocument, IrType } from './ir.ts';

/**
 * Validates an IR document against ir.schema.json (next to this file) plus the rules a JSON
 * Schema cannot express (docs/spec/ir-1.0.md, section "Semantic rules"). The Go
 * parser (apps/registry-go/internal/ir) applies the same schema and the same rules;
 * tests/ir-fixtures holds documents both must judge identically.
 *
 * A newer 1.x minor version may add optional fields, which a 1.0 reader ignores:
 * such documents are checked against the schema with every `additionalProperties:
 * false` relaxed.
 */
export function validateIr(document: unknown): string[] {
  const version = (document as { irVersion?: unknown } | null)?.irVersion;
  const minor = typeof version === 'string' ? Number(version.split('.')[1]) : 0;
  const check = minor > 0 ? lenient() : strict();
  if (!check(document)) return (check.errors ?? []).map(describeSchemaError);
  return semanticIssues(document as IrDocument);
}

let strictValidator: ValidateFunction | undefined;
let lenientValidator: ValidateFunction | undefined;

function strict(): ValidateFunction {
  strictValidator ??= new Ajv2020({ allErrors: false, strict: false }).compile(schema);
  return strictValidator;
}

function lenient(): ValidateFunction {
  lenientValidator ??= new Ajv2020({ allErrors: false, strict: false }).compile(relaxed(schema) as object);
  return lenientValidator;
}

/** The schema with every `additionalProperties: false` removed. */
function relaxed(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxed);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'additionalProperties' && value === false))
      .map(([key, value]) => [key, relaxed(value)]),
  );
}

function describeSchemaError(error: ErrorObject): string {
  return `${error.instancePath || '/'}: ${error.message ?? 'is invalid'}`;
}

function semanticIssues(ir: IrDocument): string[] {
  const issues: string[] = [];
  const permissions = new Set<string>();
  const errors = new Set(Object.keys(ir.platformErrors));
  const events = new Set<string>();
  for (const [module, definition] of Object.entries(ir.modules)) {
    for (const name of Object.keys(definition.permissions)) permissions.add(`${module}.${name}`);
    for (const code of Object.keys(definition.errors)) errors.add(`${module}.${code}`);
    for (const name of Object.keys(definition.events)) events.add(`${module}.${name}`);
  }

  const checkRefs = (type: IrType, path: string): void => {
    switch (type.kind) {
      case 'ref':
        if (!(type.name in ir.types)) issues.push(`${path}: reference to undefined type "${type.name}"`);
        return;
      case 'array':
        return checkRefs(type.items, `${path}[]`);
      case 'object':
        for (const [name, field] of Object.entries(type.fields)) checkRefs(field.type, `${path}.${name}`);
        return;
      default:
        return;
    }
  };

  for (const [name, type] of Object.entries(ir.types)) checkRefs(type, `types.${name}`);
  if (issues.length > 0) return issues;

  const cycle = findReferenceCycle(ir);
  if (cycle) return [`types: reference cycle ${cycle.join(' -> ')}`];

  for (const [module, definition] of Object.entries(ir.modules)) {
    for (const [name, operation] of Object.entries(definition.operations)) {
      const path = `${module}.${name}`;
      for (const permission of operation.requires) {
        if (!permissions.has(permission)) issues.push(`${path}: requires undeclared permission "${permission}"`);
      }
      for (const code of operation.errors) {
        if (!errors.has(code)) issues.push(`${path}: lists undeclared error "${code}"`);
      }
      checkRefs(operation.input, `${path}.input`);
      checkRefs(operation.output, `${path}.output`);
    }
    for (const [name, event] of Object.entries(definition.events)) {
      const path = `${module}.events.${name}`;
      checkRefs(event.payload, `${path}.payload`);
      if (resolve(event.payload, ir)?.kind !== 'object') issues.push(`${path}.payload: event payloads must be objects`);
    }
    for (const event of definition.subscribes) {
      if (!events.has(event)) issues.push(`${module}.subscribes: unknown event "${event}"`);
      else if (event.startsWith(`${module}.`)) issues.push(`${module}.subscribes: "${event}" is the module's own event`);
    }
  }
  return issues;
}

function resolve(type: IrType, ir: IrDocument): IrType | undefined {
  let current: IrType | undefined = type;
  while (current?.kind === 'ref') current = ir.types[current.name];
  return current;
}

/** A named type that reaches itself would make every recursive walk loop forever. */
function findReferenceCycle(ir: IrDocument): string[] | undefined {
  const done = new Set<string>();
  const visit = (name: string, stack: string[]): string[] | undefined => {
    if (stack.includes(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (done.has(name)) return undefined;
    const found = refsIn(ir.types[name]!)
      .map((next) => visit(next, [...stack, name]))
      .find((c) => c !== undefined);
    done.add(name);
    return found;
  };
  for (const name of Object.keys(ir.types).sort()) {
    const cycle = visit(name, []);
    if (cycle) return cycle;
  }
  return undefined;
}

function refsIn(type: IrType): string[] {
  switch (type.kind) {
    case 'ref':
      return [type.name];
    case 'array':
      return refsIn(type.items);
    case 'object':
      return Object.values(type.fields).flatMap((field) => refsIn(field.type));
    default:
      return [];
  }
}
