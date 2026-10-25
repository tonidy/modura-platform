import { createHash } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import {
  canonicalCompactJson,
  checkCompatibility,
  compareCodeUnits,
  irSha256,
  validateIr,
  type Change,
  type IrDocument,
} from '@modura/compiler';
import * as irChecks from './generated/ir-checks.js';

// The Contract Registry's storage and rules (ADR-0008), in one SQLite-backed Durable
// Object. A Durable Object runs one request at a time, and publish() never awaits, so
// publishes are strictly serial without the Go service's advisory lock, and an
// idempotency key can never be seen half-claimed.

export interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  MODURA_VIEWER_TOKEN?: string;
  MODURA_CASHIER_TOKEN?: string;
  MODURA_PUBLISHER_TOKEN?: string;
  MODURA_CLIENT_IP_HEADER?: string;
  MODURA_COMMANDS_PER_MIN?: string;
}

export interface ReleaseSummary {
  number: number;
  publishedAt: string;
  publishedBy: string;
  irVersion: string;
  irSha256: string;
  modules: { name: string; version: string }[];
}

export interface Release {
  summary: ReleaseSummary;
  changes: Pick<Change, 'module' | 'path' | 'message' | 'severity'>[];
}

export interface PublishRequest {
  scope: string;
  key: string;
  ir: unknown;
  basedOn?: number;
  publisher: string;
}

export interface Rejection {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type PublishOutcome = { ok: true; release: Release; replayed: boolean } | Rejection;

const PUBLISH_OPERATION = 'registry.publishRelease';

// Applied on every start. IF NOT EXISTS is enough while there is one schema version;
// the next change needs a real migration step.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  operation     TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
-- Append-only: a release is never updated or deleted, so a number always means the
-- same contract. ir holds the canonical compact JSON exactly as it was hashed.
CREATE TABLE IF NOT EXISTS contract_releases (
  number       INTEGER PRIMARY KEY CHECK (number >= 1),
  ir           TEXT NOT NULL,
  ir_sha256    TEXT NOT NULL,
  ir_version   TEXT NOT NULL,
  modules      TEXT NOT NULL,
  changes      TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS contract_releases_no_update BEFORE UPDATE ON contract_releases
BEGIN SELECT RAISE(ABORT, 'contract_releases is append-only'); END;
CREATE TRIGGER IF NOT EXISTS contract_releases_no_delete BEFORE DELETE ON contract_releases
BEGIN SELECT RAISE(ABORT, 'contract_releases is append-only'); END;
`;

interface ReleaseRow extends Record<string, SqlStorageValue> {
  number: number;
  ir: string;
  ir_sha256: string;
  ir_version: string;
  modules: string;
  changes: string;
  published_by: string;
  published_at: string;
}

export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  ping(): boolean {
    return this.sql.exec('SELECT 1 AS ok').one().ok === 1;
  }

  /**
   * A token bucket per client IP, for commands only: every demo visitor shares one
   * public identity, so limiting per identity would throttle everyone together. It
   * lives here because this object is the one place every request meets. Returns
   * the seconds to wait, or 0 when the command may go ahead.
   */
  takeCommandToken(ip: string, perMinute: number): number {
    if (perMinute <= 0) return 0;
    const rate = perMinute / 60_000;
    const burst = Math.max(5, Math.floor(perMinute / 3));
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 10 * 60_000) this.buckets.delete(key);
    }
    const bucket = this.buckets.get(ip) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * rate);
    bucket.at = now;
    this.buckets.set(ip, bucket);
    if (bucket.tokens < 1) return Math.max(1, Math.round(60 / perMinute));
    bucket.tokens -= 1;
    return 0;
  }

  /**
   * Publishes a release, applying the checks of apps/registry-go/internal/store/
   * registry.go in the same order and with the same codes and messages. Nothing is
   * written on a rejection, so the idempotency key stays free for a fixed retry.
   */
  publish(req: PublishRequest): PublishOutcome {
    const fingerprint = publishFingerprint(req.ir, req.basedOn);
    const stored = this.sql
      .exec<{ fingerprint: string; response_body: string }>(
        'SELECT fingerprint, response_body FROM idempotency_keys WHERE scope = ? AND key = ?',
        req.scope,
        req.key,
      )
      .toArray()[0];
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        return reject(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different publish. Use a new key per attempt.',
        );
      }
      return { ok: true, release: JSON.parse(stored.response_body) as Release, replayed: true };
    }

    // The Go parser reads IR 0.2.0 (old releases) but refuses to publish it.
    const version = (req.ir as { irVersion?: unknown } | null)?.irVersion;
    if (version === '0.2.0') {
      return reject('registry.INVALID_IR', `IR ${version} can still be read, but new releases must use IR 1.x.`);
    }
    const issues = validateIr(req.ir, irChecks);
    if (issues.length > 0) {
      return reject('registry.INVALID_IR', `The document is not a valid Modura IR document: ${issues[0]}`);
    }
    const document = req.ir as IrDocument;
    const canonical = canonicalCompactJson(document);
    const sha = irSha256(document);

    const latest = this.sql
      .exec<ReleaseRow>('SELECT * FROM contract_releases ORDER BY number DESC LIMIT 1')
      .toArray()[0];
    const latestNumber = latest?.number ?? 0;
    if ((req.basedOn ?? 0) !== latestNumber) {
      return reject(
        'registry.STALE_BASE',
        `This publish was compared against release ${describe(req.basedOn ?? 0)}, but the latest is ${describe(latestNumber)}.`,
        { latest: latest ? latestNumber : null },
      );
    }

    let changes: Release['changes'] = [];
    if (latest) {
      if (sha === latest.ir_sha256) {
        return reject('registry.NOTHING_TO_PUBLISH', `The document is identical to release ${latestNumber}.`, {
          latest: latestNumber,
        });
      }
      const report = checkCompatibility(JSON.parse(latest.ir) as IrDocument, document);
      if (report.violations.length > 0) {
        return reject('registry.INCOMPATIBLE_CHANGE', `The release breaks clients: ${report.violations[0]}`, {
          changes: report.changes,
          violations: report.violations,
        });
      }
      changes = report.changes.map(({ module, path, message, severity }) => ({ module, path, message, severity }));
    }

    const release: Release = {
      summary: {
        number: latestNumber + 1,
        publishedAt: new Date().toISOString(),
        publishedBy: req.publisher,
        irVersion: document.irVersion,
        irSha256: sha,
        modules: Object.keys(document.modules)
          .sort(compareCodeUnits)
          .map((name) => ({ name, version: document.modules[name]!.version })),
      },
      changes,
    };
    const { summary } = release;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO contract_releases (number, ir, ir_sha256, ir_version, modules, changes, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        summary.number,
        canonical,
        sha,
        summary.irVersion,
        JSON.stringify(summary.modules),
        JSON.stringify(changes),
        summary.publishedBy,
        summary.publishedAt,
      );
      this.sql.exec(
        `INSERT INTO idempotency_keys (scope, key, operation, fingerprint, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        req.scope,
        req.key,
        PUBLISH_OPERATION,
        fingerprint,
        JSON.stringify(release),
        summary.publishedAt,
      );
    });
    return { ok: true, release, replayed: false };
  }

  /** Release summaries, newest first. */
  list(limit: number): ReleaseSummary[] {
    return this.sql
      .exec<ReleaseRow>('SELECT * FROM contract_releases ORDER BY number DESC LIMIT ?', limit)
      .toArray()
      .map((row) => toRelease(row).summary);
  }

  /** One release and its canonical IR text, or the latest when number is undefined. */
  get(number?: number): { release: Release; ir: string } | null {
    const row = (
      number === undefined
        ? this.sql.exec<ReleaseRow>('SELECT * FROM contract_releases ORDER BY number DESC LIMIT 1')
        : this.sql.exec<ReleaseRow>('SELECT * FROM contract_releases WHERE number = ?', number)
    ).toArray()[0];
    return row ? { release: toRelease(row), ir: row.ir } : null;
  }
}

function toRelease(row: ReleaseRow): Release {
  return {
    summary: {
      number: row.number,
      publishedAt: row.published_at,
      publishedBy: row.published_by,
      irVersion: row.ir_version,
      irSha256: row.ir_sha256,
      modules: JSON.parse(row.modules),
    },
    changes: JSON.parse(row.changes),
  };
}

/** Identifies a publish request for idempotency: same document and same base. */
function publishFingerprint(ir: unknown, basedOn: number | undefined): string {
  return createHash('sha256')
    .update(`${PUBLISH_OPERATION}\n${basedOn ?? 'none'}\n${canonicalCompactJson(ir as IrDocument)}`)
    .digest('hex');
}

function reject(code: string, message: string, details?: Record<string, unknown>): Rejection {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function describe(number: number): string {
  return number === 0 ? 'none' : String(number);
}
