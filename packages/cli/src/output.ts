import type { Change, CompatibilityReport } from '@modura/compiler';
import type { RegistryReleaseSummary } from './generated/registry-client.ts';

const marks = { breaking: '!', source: '~', safe: '+' } as const;

/** `!` breaks the wire contract, `~` breaks generated code only, `+` is safe. */
export function printChanges(changes: readonly Change[]): void {
  if (changes.length === 0) return;
  console.log('Contract changes:');
  for (const change of changes) {
    console.log(`  ${marks[change.severity]} ${change.path}: ${change.message}`);
  }
}

export function printReport(report: CompatibilityReport): void {
  printChanges(report.changes);
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
}

/** One line per release: number, publish time (UTC), publisher, module versions, hash prefix. */
export function formatReleases(releases: readonly RegistryReleaseSummary[]): string {
  if (releases.length === 0) return 'Nothing published yet.';
  const width = Math.max(...releases.map((r) => r.publishedBy.length));
  return releases
    .map((r) =>
      [
        String(r.number).padStart(6),
        r.publishedAt.slice(0, 16).replace('T', ' '),
        r.publishedBy.padEnd(width),
        r.irSha256.slice(0, 12),
        r.modules.map((m) => `${m.name}@${m.version}`).join(', '),
      ].join('  '),
    )
    .join('\n');
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
