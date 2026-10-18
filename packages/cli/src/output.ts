import type { Change, CompatibilityReport } from '@modura/compiler';

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

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
