/**
 * The CLI side of the Contract Registry (plan M5). This is the dogfooding: Modura's
 * own CLI talks to a Modura module through the SDK Modura generated for it.
 */
import { randomUUID } from 'node:crypto';
import { checkCompatibility, irSha256, type IrDocument } from '@modura/compiler';
import { createHttpTransport, type JsonValue } from '@modura/sdk';
import { createModuraClient } from './generated/registry-client.ts';
import { fail, printReport } from './output.ts';

export interface RegistryOptions {
  readonly url: string;
  readonly token: string;
}

function client(options: RegistryOptions) {
  return createModuraClient(createHttpTransport({ baseUrl: options.url, token: options.token }));
}

/** The latest published release, or null if nothing has been published yet. */
async function latestRelease(options: RegistryOptions) {
  const result = await client(options).registry.getRelease({});
  if (result.ok) return result.value;
  if (result.error.code === 'registry.RELEASE_NOT_FOUND') return null;
  return fail(`Could not read the registry at ${options.url}: ${result.error.code}: ${result.error.message}`);
}

export async function publish(ir: IrDocument, options: RegistryOptions): Promise<void> {
  const latest = await latestRelease(options);
  const basedOn = latest?.release.summary.number;
  if (latest) {
    // A preview only. The server runs the same rules and has the final word.
    const preview = checkCompatibility(latest.ir as unknown as IrDocument, ir);
    console.log(`Comparing with release ${basedOn}.`);
    printReport(preview);
    for (const violation of preview.violations) console.log(`  ✗ ${violation}`);
  } else {
    console.log('Nothing published yet; this will be release 1.');
  }

  // One key for this publish. Transient failures are retried with the same key, which
  // is safe by construction: the server replays instead of publishing twice (ADR-0004).
  const idempotencyKey = randomUUID();
  const input = { ir: ir as unknown as JsonValue, basedOn };
  let result = await client(options).registry.publishRelease(input, { idempotencyKey });
  for (let attempt = 1; !result.ok && result.error.retryable && attempt <= 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    result = await client(options).registry.publishRelease(input, { idempotencyKey });
  }

  if (!result.ok) {
    const { code, message, details } = result.error;
    const violations = (details?.violations as string[] | undefined) ?? [];
    fail([`Publish rejected: ${code}`, `  ${message}`, ...violations.map((v) => `  ✗ ${v}`)].join('\n'));
  }
  const { summary } = result.value;
  // The registry hashes its own canonical form; both sides follow docs/spec/ir-1.0.md,
  // so a mismatch means the document changed in transit or an implementation drifted.
  const expected = irSha256(ir);
  if (summary.irSha256 !== expected) {
    fail(`Published release ${summary.number}, but its hash ${summary.irSha256} is not the local ${expected}.`);
  }
  console.log(
    `Published release ${summary.number}${result.replayed ? ' (replayed)' : ''}: ` +
      summary.modules.map((m) => `${m.name}@${m.version}`).join(', '),
  );
}

export async function compatAgainstRegistry(ir: IrDocument, options: RegistryOptions): Promise<void> {
  const latest = await latestRelease(options);
  if (!latest) {
    console.log('Nothing published yet, so there is nothing to compare against.');
    return;
  }
  const report = checkCompatibility(latest.ir as unknown as IrDocument, ir);
  printReport(report);
  if (report.violations.length > 0) fail(report.violations.join('\n'));
  console.log(`Compatible with release ${latest.release.summary.number}.`);
}
