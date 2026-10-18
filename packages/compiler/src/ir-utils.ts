import { compareCodeUnits } from './canonical-json.ts';
import type { IrDocument, IrError, IrOperation } from './ir.ts';

/** Helpers shared by generators, so every surface walks and names the IR the same way. */

export interface OperationEntry {
  /** Qualified name, for example "inventory.getStock". */
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly operation: IrOperation;
}

/** Every operation in the document, sorted by qualified name. */
export function listOperations(ir: IrDocument): OperationEntry[] {
  return Object.entries(ir.modules)
    .flatMap(([module, definition]) =>
      Object.entries(definition.operations).map(([name, operation]) => ({
        id: `${module}.${name}`,
        module,
        name,
        operation,
      })),
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id));
}

/** Looks up a platform code ("FORBIDDEN") or a qualified domain code ("sales.INSUFFICIENT_STOCK"). */
export function errorDefinition(ir: IrDocument, code: string): IrError {
  const dot = code.indexOf('.');
  const definition =
    dot === -1
      ? ir.platformErrors[code]
      : ir.modules[code.slice(0, dot)]?.errors[code.slice(dot + 1)];
  if (definition === undefined) throw new Error(`IR references undefined error "${code}"`);
  return definition;
}

/** "catalog.ProductId" -> "CatalogProductId", ("inventory", "getStock") -> "InventoryGetStock". */
export function pascalCase(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split('.'))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
