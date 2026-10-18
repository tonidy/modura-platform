import { platformErrors, type PlatformErrorCode } from '@modura/runtime-contracts';
import type {
  EventDefinition,
  ModuleDefinition,
  NamedType,
  OperationDefinition,
  TypeNode,
} from '@modura/schema';
import { canonicalJson, compareCodeUnits } from './canonical-json.ts';
import {
  IR_VERSION,
  type IrDocument,
  type IrEvent,
  type IrModule,
  type IrObjectType,
  type IrOperation,
  type IrType,
} from './ir.ts';
import { generatedNames, RESERVED_IDENTIFIERS } from './names.ts';

export interface CompileIssue {
  readonly path: string;
  readonly message: string;
}

export class CompileError extends Error {
  readonly issues: readonly CompileIssue[];

  constructor(issues: readonly CompileIssue[]) {
    super(
      [
        `Schema compilation failed with ${issues.length} issue(s):`,
        ...issues.map((issue) => `  ${issue.path}: ${issue.message}`),
      ].join('\n'),
    );
    this.name = 'CompileError';
    this.issues = issues;
  }
}

export interface CompileResult {
  readonly ir: IrDocument;
  /** Problems that do not stop compilation, such as unused declarations. */
  readonly warnings: readonly CompileIssue[];
}

/**
 * Validates module definitions and lowers them to the canonical IR. All issues are
 * collected before throwing, so one run reports every problem in the schema.
 */
export function compile(modules: readonly ModuleDefinition[]): IrDocument {
  return compileWithWarnings(modules).ir;
}

/** Like `compile`, but also returns warnings. `modura generate --strict` fails on them. */
export function compileWithWarnings(modules: readonly ModuleDefinition[]): CompileResult {
  return new Compiler(modules).run();
}

const names = {
  module: /^[a-z][a-zA-Z0-9]*$/,
  /** Operations, permissions, events and fields. */
  member: /^[a-z][a-zA-Z0-9]*$/,
  errorCode: /^[A-Z][A-Z0-9_]*$/,
  type: /^[a-z][a-zA-Z0-9]*\.[A-Z][a-zA-Z0-9]*$/,
  version: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  enumValue: /^[a-z][a-z0-9_]*$/,
};

/** Go's RE2 engine has no lookaround or backreferences. */
const nonPortableRegex = /\(\?<?[=!]|\\[1-9]|\\k</;

/**
 * Every operation requires a permission (enforced below), so authentication and
 * authorization failures are always possible.
 */
const alwaysPossibleErrors: readonly PlatformErrorCode[] = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
];

const idempotencyErrors: readonly PlatformErrorCode[] = [
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
];

class Compiler {
  private readonly modules: readonly ModuleDefinition[];
  private readonly issues: CompileIssue[] = [];
  private readonly warnings: CompileIssue[] = [];
  private readonly moduleNames = new Set<string>();
  private readonly permissions = new Set<string>();
  private readonly domainErrors = new Set<string>();
  private readonly events = new Set<string>();
  private readonly usedPermissions = new Set<string>();
  private readonly usedErrors = new Set<string>();
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly types: Record<string, IrType> = {};
  private readonly typeSources = new Map<string, NamedType>();

  constructor(modules: readonly ModuleDefinition[]) {
    this.modules = modules;
  }

  run(): CompileResult {
    // Declare everything first so references resolve regardless of module order.
    for (const module of this.modules) this.declare(module);

    const lowered = this.modules.map((module) => this.lowerModule(module));
    if (this.issues.length > 0) throw new CompileError(this.issues);

    // Dependencies are assigned last: lowering a named type owned by module A can
    // happen while lowering module B, and still adds to A's dependencies.
    const modules: Record<string, IrModule> = {};
    for (const [index, module] of this.modules.entries()) {
      modules[module.name] = {
        ...lowered[index]!,
        dependencies: sortedUnique(this.dependencies.get(module.name) ?? []),
      };
    }

    const ir: IrDocument = {
      irVersion: IR_VERSION,
      modules,
      types: this.types,
      platformErrors: mapValues(platformErrors, (error) => ({ ...error })),
    };
    this.checkGeneratedNames(ir);
    if (this.issues.length > 0) throw new CompileError(this.issues);

    this.warnAboutUnused();
    return { ir, warnings: this.warnings };
  }

  private declare(module: ModuleDefinition): void {
    const path = module.name;
    if (!names.module.test(module.name)) this.report(path, 'module names are lowerCamelCase');
    if (this.moduleNames.has(module.name)) this.report(path, 'module is defined more than once');
    if (!names.version.test(module.version)) {
      this.report(`${path}.version`, `"${module.version}" is not a MAJOR.MINOR.PATCH version`);
    }
    if (module.description.trim() === '') this.report(path, 'modules need a description');

    this.moduleNames.add(module.name);
    this.dependencies.set(module.name, new Set());

    for (const name of Object.keys(module.permissions ?? {})) {
      if (!names.member.test(name)) {
        this.report(`${path}.permissions.${name}`, 'permission names are lowerCamelCase');
      }
      this.permissions.add(`${module.name}.${name}`);
    }
    for (const code of Object.keys(module.errors ?? {})) {
      if (!names.errorCode.test(code)) {
        this.report(`${path}.errors.${code}`, 'error codes are UPPER_SNAKE_CASE');
      }
      this.domainErrors.add(`${module.name}.${code}`);
    }
    for (const name of Object.keys(module.events ?? {})) {
      if (!names.member.test(name)) {
        this.report(`${path}.events.${name}`, 'event names are lowerCamelCase');
      }
      this.events.add(`${module.name}.${name}`);
    }
  }

  private lowerModule(module: ModuleDefinition): Omit<IrModule, 'dependencies'> {
    return {
      version: module.version,
      description: module.description,
      permissions: mapValues(module.permissions ?? {}, (description) => ({ description })),
      errors: mapValues(module.errors ?? {}, (error) => ({
        category: error.category,
        retryable: error.retryable,
        description: error.description,
      })),
      operations: mapValues(module.operations, (operation, name) =>
        this.lowerOperation(module.name, name, operation),
      ),
      events: mapValues(module.events ?? {}, (event, name) =>
        this.lowerEvent(module.name, name, event),
      ),
      subscribes: this.lowerSubscriptions(module),
    };
  }

  private lowerOperation(
    moduleName: string,
    name: string,
    operation: OperationDefinition,
  ): IrOperation {
    const path = `${moduleName}.${name}`;
    if (!names.member.test(name)) this.report(path, 'operation names are lowerCamelCase');
    if (operation.description.trim() === '') {
      this.report(path, 'operations need a description; docs and MCP tools reuse it');
    }

    if (operation.requires.length === 0) {
      this.report(`${path}.requires`, 'operations must require at least one permission');
    }
    for (const permission of operation.requires) {
      if (this.permissions.has(permission)) {
        this.usedPermissions.add(permission);
        this.dependOn(moduleName, ownerOf(permission));
      } else {
        this.report(`${path}.requires`, `unknown permission "${permission}"`);
      }
    }

    const idempotent = operation.idempotent ?? false;
    if (idempotent && operation.kind === 'query') {
      this.report(path, 'only commands can be idempotent; queries are already safe to retry');
    }

    const mcp = operation.expose?.mcp ?? false;
    if (mcp && operation.kind === 'command') {
      this.report(path, 'v1 exposes only queries to MCP; commands stay off AI surfaces');
    }

    const domainErrors = (operation.errors ?? []).map((code) => {
      const qualified = code.includes('.') ? code : `${moduleName}.${code}`;
      if (this.domainErrors.has(qualified)) {
        this.usedErrors.add(qualified);
        this.dependOn(moduleName, ownerOf(qualified));
      } else {
        this.report(`${path}.errors`, `unknown error "${qualified}"`);
      }
      return qualified;
    });

    if (operation.input.kind !== 'object') {
      this.report(`${path}.input`, 'operation input must be t.object(...)');
    }

    return {
      kind: operation.kind,
      description: operation.description,
      requires: sortedUnique(operation.requires),
      idempotent,
      input: this.lowerType(operation.input, `${path}.input`, moduleName) as IrObjectType,
      output: this.lowerType(operation.output, `${path}.output`, moduleName),
      errors: sortedUnique([
        ...domainErrors,
        ...alwaysPossibleErrors,
        ...(idempotent ? idempotencyErrors : []),
      ]),
      expose: { mcp },
    };
  }

  private lowerEvent(moduleName: string, name: string, event: EventDefinition): IrEvent {
    const path = `${moduleName}.events.${name}`;
    if (event.description.trim() === '') this.report(path, 'events need a description');
    if (!isObjectType(event.payload)) {
      this.report(`${path}.payload`, 'event payloads must be objects, inline or named');
    }
    return {
      description: event.description,
      payload: this.lowerType(event.payload, `${path}.payload`, moduleName),
    };
  }

  private lowerSubscriptions(module: ModuleDefinition): string[] {
    for (const event of module.subscribes ?? []) {
      const path = `${module.name}.subscribes`;
      if (!this.events.has(event)) this.report(path, `unknown event "${event}"`);
      else if (ownerOf(event) === module.name) {
        this.report(path, `"${event}" is this module's own event; modules only subscribe to others`);
      } else {
        this.dependOn(module.name, ownerOf(event));
      }
    }
    return sortedUnique(module.subscribes ?? []);
  }

  /** `owner` is the module whose dependencies grow when this type references another. */
  private lowerType(node: TypeNode, path: string, owner: string): IrType {
    switch (node.kind) {
      case 'named':
        return this.lowerNamed(node, path, owner);
      case 'string':
        this.checkRange(path, node.minLength, node.maxLength, ['minLength', 'maxLength'], 0);
        if (node.pattern !== undefined) this.checkPattern(path, node.pattern);
        return { ...node };
      case 'integer':
        this.checkRange(path, node.minimum, node.maximum, ['minimum', 'maximum']);
        return { ...node };
      case 'boolean':
      case 'timestamp':
      case 'money':
      case 'json':
        return { ...node };
      case 'enum':
        if (node.values.length === 0) this.report(path, 'enums need at least one value');
        if (new Set(node.values).size !== node.values.length) {
          this.report(path, 'enum values must be unique');
        }
        for (const value of node.values) {
          if (!names.enumValue.test(value)) {
            this.report(path, `enum value "${value}" must be lower_snake_case so every generator can name it`);
          }
        }
        return { ...node, values: [...node.values] };
      case 'array':
        this.checkRange(path, node.minItems, node.maxItems, ['minItems', 'maxItems'], 0);
        return { ...node, items: this.lowerType(node.items, `${path}[]`, owner) };
      case 'object':
        return {
          kind: 'object',
          description: node.description,
          fields: mapValues(node.fields, (field, name) => {
            if (!names.member.test(name)) {
              this.report(`${path}.${name}`, 'field names are lowerCamelCase');
            }
            return {
              required: !field.optional,
              type: this.lowerType(field.type, `${path}.${name}`, owner),
            };
          }),
        };
    }
  }

  private lowerNamed(node: NamedType, path: string, from: string): IrType {
    const owner = ownerOf(node.name);
    if (!names.type.test(node.name)) {
      this.report(path, `type name "${node.name}" must look like module.PascalCase`);
    } else if (!this.moduleNames.has(owner)) {
      this.report(path, `type "${node.name}" belongs to unknown module "${owner}"`);
    } else {
      this.dependOn(from, owner);
    }

    const known = this.typeSources.get(node.name);
    if (known === undefined) {
      this.typeSources.set(node.name, node);
      this.types[node.name] = this.lowerType(node.type, node.name, owner);
    } else if (known !== node && canonicalJson(known) !== canonicalJson(node)) {
      this.report(path, `type "${node.name}" is defined twice with different shapes`);
    }
    return { kind: 'ref', name: node.name };
  }

  /** Two contract names that turn into the same identifier would break generated code. */
  private checkGeneratedNames(ir: IrDocument): void {
    const seen = new Map<string, string>();
    for (const { identifier, source } of generatedNames(ir)) {
      if (RESERVED_IDENTIFIERS.has(identifier)) {
        this.report(source, `generates "${identifier}", which is reserved by the generated SDK or OpenAPI`);
      }
      const other = seen.get(identifier);
      if (other !== undefined && other !== source) {
        this.report(source, `generates "${identifier}", which ${other} also generates`);
      }
      seen.set(identifier, source);
    }
  }

  private warnAboutUnused(): void {
    for (const permission of this.permissions) {
      if (!this.usedPermissions.has(permission)) {
        this.warnings.push({ path: permission, message: 'permission is declared but no operation requires it' });
      }
    }
    for (const error of this.domainErrors) {
      if (!this.usedErrors.has(error)) {
        this.warnings.push({ path: error, message: 'error is declared but no operation can return it' });
      }
    }
  }

  private checkRange(
    path: string,
    min: number | undefined,
    max: number | undefined,
    labels: readonly [string, string],
    floor?: number,
  ): void {
    for (const [label, value] of [
      [labels[0], min],
      [labels[1], max],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value)) this.report(path, `${label} must be a safe integer`);
      else if (floor !== undefined && value < floor) this.report(path, `${label} cannot be negative`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      this.report(path, `${labels[0]} is greater than ${labels[1]}`);
    }
  }

  private checkPattern(path: string, pattern: string): void {
    try {
      new RegExp(pattern, 'u');
    } catch {
      this.report(path, `pattern "${pattern}" is not a valid regular expression`);
      return;
    }
    if (nonPortableRegex.test(pattern)) {
      this.report(
        path,
        `pattern "${pattern}" uses lookaround or backreferences, which Go's RE2 engine cannot run`,
      );
    }
  }

  private dependOn(from: string, to: string): void {
    if (from !== to) this.dependencies.get(from)?.add(to);
  }

  private report(path: string, message: string): void {
    this.issues.push({ path, message });
  }
}

function isObjectType(node: TypeNode): boolean {
  return node.kind === 'object' || (node.kind === 'named' && isObjectType(node.type));
}

function ownerOf(qualifiedName: string): string {
  return qualifiedName.slice(0, qualifiedName.indexOf('.'));
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function mapValues<V, R>(
  record: Readonly<Record<string, V>>,
  fn: (value: V, key: string) => R,
): Record<string, R> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value, key)]));
}
