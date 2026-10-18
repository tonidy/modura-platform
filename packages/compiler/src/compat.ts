import { compareCodeUnits } from './canonical-json.ts';
import type { IrDocument, IrEvent, IrModule, IrOperation, IrType } from './ir.ts';

/**
 * Compares two IR documents and decides which changes affect existing clients
 * (ADR-0002, ADR-0010).
 *
 * - `breaking`: the wire contract changes in a way old clients or old requests do
 *   not survive. In inputs, anything that rejects a request that used to be valid;
 *   in outputs and event payloads, anything a client may not be ready to receive.
 * - `source`: the wire is unaffected but generated code changes shape, for example
 *   a renamed named type, so code built against the old SDK stops compiling.
 * - `safe`: neither.
 *
 * `breaking` and `source` changes need a major version bump of their module, or a
 * minor bump while it is 0.x. A version that goes down is always a violation. Safe
 * changes without a minor bump produce a warning.
 *
 * The Go port (apps/registry-go/internal/compat) must produce identical reports; the
 * shared fixtures in tests/compat-fixtures enforce that.
 */

export type Severity = 'breaking' | 'source' | 'safe';

export interface Change {
  readonly module: string;
  readonly path: string;
  readonly message: string;
  readonly severity: Severity;
}

export interface CompatibilityReport {
  readonly changes: readonly Change[];
  /** Version rules the changes break. Publishing or generating is refused. */
  readonly violations: readonly string[];
  /** Advice that does not block, such as a missing minor bump. */
  readonly warnings: readonly string[];
}

type Direction = 'input' | 'output';
type Add = (path: string, message: string, severity: Severity) => void;

export function checkCompatibility(previous: IrDocument, next: IrDocument): CompatibilityReport {
  const changes: Change[] = [];

  for (const moduleName of sortedKeys(previous.modules)) {
    const before = previous.modules[moduleName]!;
    const after = next.modules[moduleName];
    const add: Add = (path, message, severity) => changes.push({ module: moduleName, path, message, severity });
    if (after === undefined) {
      add(moduleName, 'module removed', 'breaking');
      continue;
    }
    compareModule(moduleName, before, after, previous, next, add);
  }
  for (const moduleName of sortedKeys(next.modules)) {
    if (!(moduleName in previous.modules)) {
      changes.push({ module: moduleName, path: moduleName, message: 'module added', severity: 'safe' });
    }
  }

  const violations: string[] = [];
  const warnings: string[] = [];
  for (const moduleName of sortedKeys(previous.modules)) {
    const before = previous.modules[moduleName]!.version;
    const after = next.modules[moduleName]?.version;
    if (after === undefined) {
      violations.push(`${moduleName}: removing a module always breaks its clients`);
      continue;
    }
    const severities = new Set(changes.filter((c) => c.module === moduleName).map((c) => c.severity));
    const went = `the version went ${before} -> ${after}`;
    if (compareVersions(after, before) < 0) {
      violations.push(`${moduleName}: the version went down from ${before} to ${after}`);
    } else if (severities.has('breaking') && !allowsBreakingChange(before, after)) {
      violations.push(`${moduleName}: breaking changes need a major version bump (minor while 0.x), but ${went}`);
    } else if (severities.has('source') && !allowsBreakingChange(before, after)) {
      violations.push(`${moduleName}: source-breaking changes need a major version bump (minor while 0.x), but ${went}`);
    } else if (severities.size > 0 && !severities.has('breaking') && !severities.has('source') && !bumpsMinor(before, after)) {
      warnings.push(`${moduleName}: compatible changes usually come with a minor version bump, but ${went}`);
    }
  }

  return { changes, violations, warnings };
}

function compareModule(
  moduleName: string,
  before: IrModule,
  after: IrModule,
  previous: IrDocument,
  next: IrDocument,
  add: Add,
): void {
  for (const name of sortedKeys(before.operations)) {
    const path = `${moduleName}.${name}`;
    const updated = after.operations[name];
    if (updated === undefined) add(path, 'operation removed', 'breaking');
    else compareOperation(path, before.operations[name]!, updated, previous, next, add);
  }
  for (const name of sortedKeys(after.operations)) {
    if (!(name in before.operations)) add(`${moduleName}.${name}`, 'operation added', 'safe');
  }

  // Documents older than IR 1.0 have no events or subscriptions.
  const eventsBefore: Readonly<Record<string, IrEvent>> = before.events ?? {};
  const eventsAfter: Readonly<Record<string, IrEvent>> = after.events ?? {};
  const types = new TypeComparer(previous, next, add);
  for (const name of sortedKeys(eventsBefore)) {
    const path = `${moduleName}.events.${name}`;
    const updated = eventsAfter[name];
    if (updated === undefined) add(path, 'event removed', 'breaking');
    // Consumers receive payloads, so they compare like outputs.
    else types.compare(eventsBefore[name]!.payload, updated.payload, 'output', `${path}.payload`);
  }
  for (const name of sortedKeys(eventsAfter)) {
    if (!(name in eventsBefore)) add(`${moduleName}.events.${name}`, 'event added', 'safe');
  }

  const subscribesBefore = before.subscribes ?? [];
  const subscribesAfter = after.subscribes ?? [];
  for (const event of subscribesAfter) {
    if (!subscribesBefore.includes(event)) add(moduleName, `now subscribes to ${event}`, 'safe');
  }
  for (const event of subscribesBefore) {
    if (!subscribesAfter.includes(event)) add(moduleName, `no longer subscribes to ${event}`, 'safe');
  }
}

function compareOperation(
  path: string,
  before: IrOperation,
  after: IrOperation,
  previous: IrDocument,
  next: IrDocument,
  add: Add,
): void {
  if (before.kind !== after.kind) add(path, `kind changed from ${before.kind} to ${after.kind}`, 'breaking');

  for (const permission of after.requires) {
    if (!before.requires.includes(permission)) add(path, `now requires ${permission}`, 'breaking');
  }
  for (const permission of before.requires) {
    if (!after.requires.includes(permission)) add(path, `no longer requires ${permission}`, 'safe');
  }

  if (!before.idempotent && after.idempotent) {
    add(path, 'became idempotent; callers must now send an idempotency key', 'breaking');
  } else if (before.idempotent && !after.idempotent) {
    add(path, 'is no longer idempotent', 'safe');
  }

  for (const code of after.errors) {
    if (!before.errors.includes(code)) add(path, `can now return ${code}`, 'safe');
  }
  if (before.expose.mcp !== after.expose.mcp) {
    add(path, `MCP exposure ${after.expose.mcp ? 'added' : 'removed'}`, 'safe');
  }

  const types = new TypeComparer(previous, next, add);
  types.compare(before.input, after.input, 'input', `${path}.input`);
  types.compare(before.output, after.output, 'output', `${path}.output`);
}

class TypeComparer {
  private readonly previous: IrDocument;
  private readonly next: IrDocument;
  private readonly add: Add;

  constructor(previous: IrDocument, next: IrDocument, add: Add) {
    this.previous = previous;
    this.next = next;
    this.add = add;
  }

  compare(before: IrType, after: IrType, direction: Direction, path: string): void {
    // Which named type is used is invisible on the wire but shapes generated code.
    if (before.kind === 'ref' && after.kind === 'ref') {
      if (before.name !== after.name) {
        this.add(path, `type name changed from ${before.name} to ${after.name}`, 'source');
      }
    } else if (before.kind === 'ref') {
      this.add(path, `type ${before.name} is no longer used here`, 'source');
    } else if (after.kind === 'ref') {
      this.add(path, `now uses the named type ${after.name}`, 'source');
    }

    const a = this.resolve(before, this.previous);
    const b = this.resolve(after, this.next);
    if (a.kind !== b.kind) {
      this.add(path, `type changed from ${a.kind} to ${b.kind}`, 'breaking');
      return;
    }

    switch (a.kind) {
      case 'string': {
        const s = b as typeof a;
        this.bound(path, 'minLength', 'min', a.minLength, s.minLength, direction);
        this.bound(path, 'maxLength', 'max', a.maxLength, s.maxLength, direction);
        if (a.pattern !== s.pattern) {
          this.add(path, `pattern changed from ${a.pattern ?? 'none'} to ${s.pattern ?? 'none'}`, 'breaking');
        }
        return;
      }
      case 'integer': {
        const i = b as typeof a;
        this.bound(path, 'minimum', 'min', a.minimum, i.minimum, direction);
        this.bound(path, 'maximum', 'max', a.maximum, i.maximum, direction);
        return;
      }
      case 'enum': {
        const e = b as typeof a;
        for (const value of a.values) {
          if (!e.values.includes(value)) {
            this.add(path, `enum value "${value}" removed`, direction === 'input' ? 'breaking' : 'safe');
          }
        }
        for (const value of e.values) {
          if (!a.values.includes(value)) {
            this.add(path, `enum value "${value}" added`, direction === 'output' ? 'breaking' : 'safe');
          }
        }
        return;
      }
      case 'array': {
        const arr = b as typeof a;
        this.bound(path, 'minItems', 'min', a.minItems, arr.minItems, direction);
        this.bound(path, 'maxItems', 'max', a.maxItems, arr.maxItems, direction);
        this.compare(a.items, arr.items, direction, `${path}[]`);
        return;
      }
      case 'object': {
        const o = b as typeof a;
        for (const name of sortedKeys(a.fields)) {
          const field = a.fields[name]!;
          const fieldPath = `${path}.${name}`;
          const updated = o.fields[name];
          if (updated === undefined) {
            // Inputs are closed objects, so clients still sending the field get rejected.
            this.add(fieldPath, 'field removed', 'breaking');
            continue;
          }
          if (field.required !== updated.required) {
            const nowRequired = updated.required;
            const breaking = direction === 'input' ? nowRequired : !nowRequired;
            this.add(fieldPath, nowRequired ? 'became required' : 'became optional', breaking ? 'breaking' : 'safe');
          }
          this.compare(field.type, updated.type, direction, fieldPath);
        }
        for (const name of sortedKeys(o.fields)) {
          if (!(name in a.fields)) {
            const required = direction === 'input' && o.fields[name]!.required;
            this.add(`${path}.${name}`, `${required ? 'required ' : ''}field added`, required ? 'breaking' : 'safe');
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private resolve(type: IrType, ir: IrDocument): Exclude<IrType, { kind: 'ref' }> {
    if (type.kind !== 'ref') return type;
    const target = ir.types[type.name];
    if (target === undefined) throw new Error(`IR references undefined type "${type.name}"`);
    return this.resolve(target, ir);
  }

  /** Narrowing an input bound rejects old requests; widening an output bound surprises old clients. */
  private bound(
    path: string,
    label: string,
    side: 'min' | 'max',
    before: number | undefined,
    after: number | undefined,
    direction: Direction,
  ): void {
    if (before === after) return;
    const open = side === 'min' ? -Infinity : Infinity;
    const narrowed = side === 'min' ? (after ?? open) > (before ?? open) : (after ?? open) < (before ?? open);
    const breaking = direction === 'input' ? narrowed : !narrowed;
    this.add(path, `${label} changed from ${before ?? 'none'} to ${after ?? 'none'}`, breaking ? 'breaking' : 'safe');
  }
}

function sortedKeys(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort(compareCodeUnits);
}

function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return [major, minor, patch];
}

function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

function allowsBreakingChange(before: string, after: string): boolean {
  const [major0, minor0] = parseVersion(before);
  const [major1, minor1] = parseVersion(after);
  if (major1 > major0) return true;
  return major0 === 0 && major1 === 0 && minor1 > minor0;
}

function bumpsMinor(before: string, after: string): boolean {
  const [major0, minor0] = parseVersion(before);
  const [major1, minor1] = parseVersion(after);
  return major1 > major0 || (major1 === major0 && minor1 > minor0);
}
