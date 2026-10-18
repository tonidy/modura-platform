import { createHash } from 'node:crypto';

/**
 * The canonical compact form of a JSON document and its SHA-256, as defined in
 * docs/spec/ir-1.0.md. The registry computes `irSha256` with the Go implementation
 * (apps/registry-go/internal/ir.Canonical); tests/ir-fixtures/hashes.json proves both
 * produce the same bytes.
 *
 * The form is JSON.stringify of the value with object keys sorted by Unicode code
 * point (which equals UTF-8 byte order), and integers only. It differs from the
 * pretty `canonicalJson` used for checked-in files, which sorts by UTF-16 code unit:
 * for IR names, which are ASCII, the two orders agree.
 */
export function canonicalCompactJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, '$'));
}

export function irSha256(document: unknown): string {
  return createHash('sha256').update(canonicalCompactJson(document), 'utf8').digest('hex');
}

function sortKeys(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${path}: ${value} is not a safe integer; IR documents contain integers only`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => sortKeys(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = sortKeys(child, `${path}.${key}`);
    }
    return sorted;
  }
  throw new TypeError(`${path}: ${typeof value} is not JSON-compatible`);
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}
