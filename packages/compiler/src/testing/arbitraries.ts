/**
 * fast-check arbitraries for property-based tests of the schema engine (plan M6).
 * Exported as @modura/compiler/testing so generator and CLI tests can use them too.
 *
 * Everything generated is a valid contract by construction: names come from small
 * vocabularies that cannot collide after PascalCase, constraints are ordered, and
 * references point at types that exist.
 */
import fc from 'fast-check';
import type { EventDefinition, ModuleDefinition, OperationDefinition, TypeNode } from '@modura/schema';
import type { IrDocument, IrType } from '../ir.ts';

const fieldName = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,7}$/);
const enumValue = fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/);
const PATTERNS = ['^[a-z]+$', '^[A-Z]{3}-[0-9]{3}$', '^prd_[a-z0-9_]{1,20}$'];

/** Two ordered optional bounds, so min never exceeds max. */
function bounds(low: number, high: number) {
  return fc
    .tuple(fc.option(fc.integer({ min: low, max: high }), { nil: undefined }), fc.option(fc.integer({ min: low, max: high }), { nil: undefined }))
    .map(([a, b]) => (a !== undefined && b !== undefined && a > b ? [b, a] : [a, b]) as [number | undefined, number | undefined]);
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const leafType: fc.Arbitrary<TypeNode> = fc.oneof(
  fc.tuple(bounds(0, 50), fc.option(fc.constantFrom(...PATTERNS), { nil: undefined })).map(([[minLength, maxLength], pattern]) =>
    definedOnly({ kind: 'string' as const, minLength, maxLength, pattern }),
  ),
  bounds(-1000, 1000).map(([minimum, maximum]) => definedOnly({ kind: 'integer' as const, minimum, maximum })),
  fc.constantFrom<TypeNode>({ kind: 'boolean' }, { kind: 'timestamp' }, { kind: 'money' }, { kind: 'json' }),
  fc.uniqueArray(enumValue, { minLength: 1, maxLength: 4 }).map((values) => ({ kind: 'enum' as const, values })),
);

const { type: anyType } = fc.letrec<{ type: TypeNode; object: TypeNode; array: TypeNode }>((tie) => ({
  type: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leafType, tie('object'), tie('array')),
  array: fc.tuple(tie('type'), bounds(0, 20)).map(([items, [minItems, maxItems]]) =>
    definedOnly({ kind: 'array' as const, items, minItems, maxItems }),
  ),
  object: fc
    .dictionary(fieldName, fc.record({ type: tie('type'), optional: fc.boolean() }), { maxKeys: 4 })
    .map((fields) => ({ kind: 'object' as const, fields })),
}));

const objectType: fc.Arbitrary<Extract<TypeNode, { kind: 'object' }>> = fc
  .dictionary(fieldName, fc.record({ type: anyType, optional: fc.boolean() }), { maxKeys: 4 })
  .map((fields) => ({ kind: 'object' as const, fields }));

/** Operation names chosen so no PascalCase name plus a generator suffix equals another. */
const OPERATION_NAMES = ['getItem', 'listItems', 'sell', 'refund', 'ping', 'count'];
const EVENT_NAMES = ['itemSold', 'itemReturned', 'stockChanged'];

function operation(module: string, errorCodes: string[]): fc.Arbitrary<OperationDefinition> {
  return fc
    .record({
      kind: fc.constantFrom<'query' | 'command'>('query', 'command'),
      flag: fc.boolean(),
      input: objectType,
      output: anyType,
      errors: fc.subarray(errorCodes),
    })
    .map(({ kind, flag, input, output, errors }) => ({
      kind,
      description: `Operation in ${module}.`,
      requires: [`${module}.read`],
      // The flag means "idempotent" for commands and "exposed to MCP" for queries,
      // the only combinations the compiler allows.
      idempotent: kind === 'command' && flag,
      expose: { mcp: kind === 'query' && flag },
      input,
      output,
      errors,
    }));
}

/**
 * Replaces object types found while walking with named types (`module.Type0`, ...),
 * so the IR also exercises references. Deterministic for a given module.
 */
function nameSomeObjects(module: ModuleDefinition): ModuleDefinition {
  let counter = 0;
  const walk = (node: TypeNode, nameIt: boolean): TypeNode => {
    switch (node.kind) {
      case 'array':
        return { ...node, items: walk(node.items, true) };
      case 'object': {
        const fields = Object.fromEntries(
          Object.entries(node.fields).map(([name, field]) => [name, { ...field, type: walk(field.type, true) }]),
        );
        const object = { ...node, fields };
        if (!nameIt || counter % 2 === 1) {
          counter++;
          return object;
        }
        return { kind: 'named', name: `${module.name}.Type${counter++}`, type: object };
      }
      default:
        return node;
    }
  };
  return {
    ...module,
    operations: Object.fromEntries(
      Object.entries(module.operations).map(([name, op]) => [
        name,
        { ...op, input: walk(op.input, false) as never, output: walk(op.output, true) },
      ]),
    ),
  };
}

function moduleArbitrary(name: string, subscribable: string[]): fc.Arbitrary<ModuleDefinition> {
  const errorNames = ['GONE', 'BUSY', 'SOLD_OUT'];
  return fc
    .record({
      version: fc.tuple(fc.nat(3), fc.nat(5), fc.nat(5)).map((v) => v.join('.')),
      errors: fc.subarray(errorNames, { minLength: 0 }),
      operationNames: fc.subarray(OPERATION_NAMES, { minLength: 1, maxLength: 3 }),
      eventNames: fc.subarray(EVENT_NAMES, { maxLength: 2 }),
      subscribes: fc.subarray(subscribable),
    })
    .chain(({ version, errors, operationNames, eventNames, subscribes }) =>
      fc
        .record({
          operations: fc.tuple(...operationNames.map(() => operation(name, errors))),
          payloads: fc.tuple(...eventNames.map(() => objectType)),
        })
        .map(({ operations, payloads }) =>
          nameSomeObjects({
            name,
            version,
            description: `Generated module ${name}.`,
            permissions: { read: 'Read.' },
            errors: Object.fromEntries(
              errors.map((code) => [code, { category: 'unprocessable' as const, retryable: false, description: code }]),
            ),
            operations: Object.fromEntries(operationNames.map((op, i) => [op, operations[i]!])),
            events: Object.fromEntries(
              eventNames.map((event, i): [string, EventDefinition] => [event, { description: `${event}.`, payload: payloads[i]! }]),
            ),
            subscribes,
          }),
        ),
    );
}

/** One or two modules; the second may subscribe to the first one's events. */
export const contractArbitrary: fc.Arbitrary<ModuleDefinition[]> = moduleArbitrary('alpha', []).chain((alpha) =>
  fc.oneof(
    fc.constant<ModuleDefinition[]>([alpha]),
    moduleArbitrary('beta', Object.keys(alpha.events ?? {}).map((event) => `alpha.${event}`)).map((beta) => [alpha, beta]),
  ),
);

/** Reverses the key order of every plain object, deeply. Same contract, new order. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) as T;
}

// ---------------------------------------------------------------------------
// Random edits of an IR document, for compatibility parity between TypeScript and Go
// ---------------------------------------------------------------------------

type Doc = { -readonly [K in keyof IrDocument]: any };

const EDITS = [
  'bump-major', 'bump-minor', 'bump-patch', 'lower-version', 'remove-operation', 'remove-event',
  'toggle-required', 'remove-field', 'add-required-field', 'add-optional-field', 'change-bound',
  'drop-bound', 'add-enum-value', 'remove-enum-value', 'change-kind', 'toggle-idempotent',
  'toggle-mcp', 'add-requirement', 'rename-type', 'change-pattern',
] as const;

/** Applies `count` random edits to a copy of `ir`. The result is still a valid document. */
export function editArbitrary(ir: IrDocument): fc.Arbitrary<IrDocument> {
  return fc
    .array(fc.tuple(fc.constantFrom(...EDITS), fc.nat(1000), fc.nat(1000)), { minLength: 1, maxLength: 3 })
    .map((edits) => {
      const doc = structuredClone(ir) as Doc;
      for (const [edit, a, b] of edits) applyEdit(doc, edit, a, b);
      return doc as IrDocument;
    });
}

function pick<T>(items: readonly T[], n: number): T | undefined {
  return items.length === 0 ? undefined : items[n % items.length];
}

/** Every type node in the document, with a setter, outside of references. */
function typeSlots(doc: Doc): { get: () => IrType; set: (t: IrType) => void }[] {
  const slots: { get: () => IrType; set: (t: IrType) => void }[] = [];
  const visit = (holder: any, key: string | number) => {
    const node = holder[key] as IrType;
    slots.push({ get: () => holder[key], set: (t) => (holder[key] = t) });
    if (node.kind === 'array') visit(node, 'items');
    if (node.kind === 'object') for (const name of Object.keys(node.fields).sort()) visit(node.fields[name], 'type');
  };
  for (const name of Object.keys(doc.types).sort()) visit(doc.types, name);
  for (const m of Object.keys(doc.modules).sort()) {
    const module = doc.modules[m];
    for (const op of Object.keys(module.operations).sort()) {
      visit(module.operations[op], 'input');
      visit(module.operations[op], 'output');
    }
    for (const e of Object.keys(module.events).sort()) visit(module.events[e], 'payload');
  }
  return slots;
}

function applyEdit(doc: Doc, edit: (typeof EDITS)[number], a: number, b: number): void {
  const moduleName = pick(Object.keys(doc.modules).sort(), a)!;
  const module = doc.modules[moduleName];
  const [major, minor, patch] = module.version.split('.').map(Number);
  const slots = typeSlots(doc);
  const ofKind = (kind: string) => slots.filter((s) => s.get().kind === kind);
  const object = pick(ofKind('object'), b)?.get() as any;

  switch (edit) {
    case 'bump-major':
      module.version = `${major + 1}.0.0`;
      return;
    case 'bump-minor':
      module.version = `${major}.${minor + 1}.0`;
      return;
    case 'bump-patch':
      module.version = `${major}.${minor}.${patch + 1}`;
      return;
    case 'lower-version':
      if (major > 0) module.version = `${major - 1}.${minor}.${patch}`;
      return;
    case 'remove-operation': {
      const names = Object.keys(module.operations).sort();
      if (names.length > 1) delete module.operations[pick(names, b)!];
      return;
    }
    case 'remove-event': {
      const name = pick(Object.keys(module.events).sort(), b);
      if (name === undefined) return;
      delete module.events[name];
      // Keep the document valid: nobody may subscribe to an event that is gone.
      for (const other of Object.values(doc.modules) as any[]) {
        other.subscribes = other.subscribes.filter((s: string) => s !== `${moduleName}.${name}`);
      }
      return;
    }
    case 'toggle-required': {
      const field = object && pick(Object.keys(object.fields).sort(), a);
      if (field) object.fields[field].required = !object.fields[field].required;
      return;
    }
    case 'remove-field': {
      const field = object && pick(Object.keys(object.fields).sort(), a);
      if (field) delete object.fields[field];
      return;
    }
    case 'add-required-field':
    case 'add-optional-field':
      if (object && !('zAdded' in object.fields)) {
        object.fields.zAdded = { required: edit === 'add-required-field', type: { kind: 'boolean' } };
      }
      return;
    case 'change-bound': {
      const slot = pick([...ofKind('string'), ...ofKind('integer')], b);
      if (!slot) return;
      const node = slot.get() as any;
      const step = a % 2 === 0 ? 1 : -1;
      if (node.kind === 'string') {
        // Keep 0 <= minLength <= maxLength.
        node.maxLength = Math.max((node.maxLength ?? 10) + step * 5, node.minLength ?? 0);
      } else {
        const minimum = (node.minimum ?? 0) + step;
        node.minimum = node.maximum === undefined ? minimum : Math.min(minimum, node.maximum);
      }
      return;
    }
    case 'drop-bound': {
      const slot = pick([...ofKind('string'), ...ofKind('integer')], b);
      if (!slot) return;
      const node = slot.get() as any;
      delete node.maxLength;
      delete node.minimum;
      return;
    }
    case 'add-enum-value': {
      const node = pick(ofKind('enum'), b)?.get() as any;
      if (node && !node.values.includes('zz_added')) node.values.push('zz_added');
      return;
    }
    case 'remove-enum-value': {
      const node = pick(ofKind('enum'), b)?.get() as any;
      if (node && node.values.length > 1) node.values.splice(a % node.values.length, 1);
      return;
    }
    case 'change-kind': {
      const slot = pick(slots.filter((s) => !['object', 'ref'].includes(s.get().kind)), b);
      if (slot) slot.set(slot.get().kind === 'boolean' ? { kind: 'timestamp' } : { kind: 'boolean' });
      return;
    }
    case 'toggle-idempotent': {
      const op = pick(Object.values(module.operations) as any[], b);
      if (op?.kind === 'command') {
        op.idempotent = !op.idempotent;
        const extra = ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED'];
        op.errors = op.idempotent ? [...new Set([...op.errors, ...extra])].sort() : op.errors.filter((e: string) => !extra.includes(e));
      }
      return;
    }
    case 'toggle-mcp': {
      const op = pick(Object.values(module.operations) as any[], b);
      if (op?.kind === 'query') op.expose.mcp = !op.expose.mcp;
      return;
    }
    case 'add-requirement': {
      const op = pick(Object.values(module.operations) as any[], b);
      module.permissions.write ??= { description: 'Write.' };
      if (op && !op.requires.includes(`${moduleName}.write`)) op.requires = [...op.requires, `${moduleName}.write`].sort();
      return;
    }
    case 'rename-type': {
      const name = pick(Object.keys(doc.types).sort(), b);
      if (!name || `${name}Renamed` in doc.types) return;
      const renamed = `${name}Renamed`;
      doc.types[renamed] = doc.types[name];
      delete doc.types[name];
      for (const slot of typeSlots(doc)) {
        const node = slot.get() as any;
        if (node.kind === 'ref' && node.name === name) node.name = renamed;
      }
      return;
    }
    case 'change-pattern': {
      const node = pick(ofKind('string'), b)?.get() as any;
      if (node) node.pattern = node.pattern === PATTERNS[0] ? PATTERNS[1] : PATTERNS[0];
      return;
    }
  }
}
