export { canonicalJson, compareCodeUnits } from './canonical-json.ts';
export { checkCompatibility, type Change, type CompatibilityReport, type Severity } from './compat.ts';
export {
  compile,
  CompileError,
  compileWithWarnings,
  type CompileIssue,
  type CompileResult,
} from './compile.ts';
export { canonicalCompactJson, irSha256 } from './hash.ts';
export { generatedNames, RESERVED_IDENTIFIERS, type GeneratedName } from './names.ts';
export { validateIr } from './validate.ts';
export * from './ir.ts';
export * from './ir-utils.ts';
