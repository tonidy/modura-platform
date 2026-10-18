import type { ModuleDefinition } from '@modura/schema';

/** Shape of `modura.config.ts` at the workspace root. Output paths are relative to it. */
export interface ModuraConfig {
  readonly modules: readonly ModuleDefinition[];
  readonly api: { readonly title: string; readonly version: string };
  /**
   * Which service implements which modules (plan M7). Each service gets its own
   * OpenAPI document, so it only implements its own operations, and the SDK and MCP
   * tools route each operation to its service. Every module belongs to exactly one.
   */
  readonly services: Readonly<Record<string, { readonly modules: readonly string[]; readonly openapi: string }>>;
  /**
   * Default Contract Registry for `publish` and `compat --against registry`: a server
   * URL, or `file:<dir>` for release files committed to git (ADR-0012). The
   * `--registry` flag and `MODURA_REGISTRY_URL` override it.
   */
  readonly registry?: string;
  readonly outputs: {
    readonly ir: string;
    readonly mcp: string;
    readonly sdk: string;
  };
}

/** Module name to service name, after checking every module has exactly one service. */
export function serviceOfModule(config: ModuraConfig): Record<string, string> {
  const owner: Record<string, string> = {};
  const problems: string[] = [];
  for (const [service, { modules }] of Object.entries(config.services)) {
    for (const module of modules) {
      if (owner[module]) problems.push(`module ${module} is in both ${owner[module]} and ${service}`);
      owner[module] = service;
    }
  }
  for (const { name } of config.modules) {
    if (!owner[name]) problems.push(`module ${name} belongs to no service`);
  }
  for (const module of Object.keys(owner)) {
    if (!config.modules.some((m) => m.name === module)) problems.push(`service lists unknown module ${module}`);
  }
  if (problems.length > 0) throw new Error(`modura.config.ts services: ${problems.join('; ')}`);
  return owner;
}
