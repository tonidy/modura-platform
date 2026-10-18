import { defineModule, defineType, type ModuleDefinition, type NamedType, t } from '@modura/schema';

// The Contract Registry: Modura's own contracts, published through a Modura module.
// See docs/adr/0008-contract-registry.md.

export const ReleaseNumber: NamedType = defineType(
  'registry.ReleaseNumber',
  t.integer({ minimum: 1, description: 'Sequential release number, starting at 1.' }),
);

export const ModuleVersion: NamedType = defineType(
  'registry.ModuleVersion',
  t.object({
    name: t.string({ minLength: 1, maxLength: 60 }),
    version: t.string({ pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' }),
  }),
);

export const Change: NamedType = defineType(
  'registry.Change',
  t.object(
    {
      module: t.string({ minLength: 1 }),
      path: t.string({ minLength: 1 }),
      message: t.string({ minLength: 1 }),
      severity: t.enum(['breaking', 'source', 'safe'], {
        description: 'breaking: the wire contract; source: generated code only; safe: neither.',
      }),
    },
    { description: 'One difference found by the compatibility check (ADR-0002, ADR-0010).' },
  ),
);

export const ReleaseSummary: NamedType = defineType(
  'registry.ReleaseSummary',
  t.object({
    number: ReleaseNumber,
    publishedAt: t.timestamp(),
    publishedBy: t.string({ minLength: 1 }),
    irVersion: t.string({ minLength: 1 }),
    irSha256: t.string({ pattern: '^[0-9a-f]{64}$', description: 'SHA-256 of the canonical IR.' }),
    modules: t.array(ModuleVersion),
  }),
);

export const Release: NamedType = defineType(
  'registry.Release',
  t.object({
    summary: ReleaseSummary,
    changes: t.array(Change, { description: 'Changes against the previous release. Empty for the first.' }),
  }),
);

export const registry: ModuleDefinition = defineModule({
  name: 'registry',
  // 0.2.0: Change.breaking became Change.severity (ADR-0010).
  version: '0.2.0',
  description: 'Published releases of the Modura contracts, checked for compatibility on the server.',
  permissions: {
    read: 'Read published contract releases.',
    write: 'Publish contract releases.',
  },
  errors: {
    RELEASE_NOT_FOUND: {
      category: 'not_found',
      retryable: false,
      description: 'No release has this number, or nothing has been published yet.',
    },
    INVALID_IR: {
      category: 'unprocessable',
      retryable: false,
      description: 'The document is not a valid Modura IR document.',
    },
    INCOMPATIBLE_CHANGE: {
      category: 'unprocessable',
      retryable: false,
      description:
        'The release breaks clients of a module whose version does not allow it. Details list the changes and violations.',
    },
    STALE_BASE: {
      category: 'conflict',
      retryable: false,
      description:
        'Another release was published since the one this publish was compared against. Compare again, then publish.',
    },
    NOTHING_TO_PUBLISH: {
      category: 'unprocessable',
      retryable: false,
      description: 'The document is identical to the latest release.',
    },
  },
  operations: {
    publishRelease: {
      kind: 'command',
      description:
        'Publish a new release of the contracts. The server checks it against the latest release and rejects unversioned breaking changes.',
      requires: ['registry.write'],
      idempotent: true,
      input: t.object({
        ir: t.json({ description: 'The canonical IR document to publish.' }),
        basedOn: t.optional(ReleaseNumber),
      }),
      output: Release,
      errors: ['INVALID_IR', 'INCOMPATIBLE_CHANGE', 'STALE_BASE', 'NOTHING_TO_PUBLISH'],
    },
    listReleases: {
      kind: 'query',
      description: 'List published contract releases, newest first, with the module versions in each.',
      requires: ['registry.read'],
      input: t.object({ limit: t.optional(t.integer({ minimum: 1, maximum: 100 })) }),
      output: t.object({ releases: t.array(ReleaseSummary) }),
      expose: { mcp: true },
    },
    getRelease: {
      kind: 'query',
      description:
        'Get one contract release, or the latest if no number is given, with its IR and its changes against the previous release.',
      requires: ['registry.read'],
      input: t.object({ number: t.optional(ReleaseNumber) }),
      output: t.object({ release: Release, ir: t.json() }),
      errors: ['RELEASE_NOT_FOUND'],
      expose: { mcp: true },
    },
  },
});
