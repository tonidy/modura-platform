/**
 * Serializes a JSON-compatible value deterministically: object keys sorted by UTF-16
 * code unit, `undefined` properties dropped, two-space indentation and a trailing
 * newline. Code-unit order is used instead of `localeCompare` so the output never
 * depends on the machine's locale.
 *
 * One exception comes from JavaScript itself: integer-like keys such as HTTP status
 * codes ("200", "404") are always enumerated first, in ascending numeric order. That
 * order is just as deterministic, so it is accepted rather than fought.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value, '$'), null, 2)}\n`;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not valid JSON`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = normalize(child, `${path}.${key}`);
    }
    return sorted;
  }
  throw new TypeError(`${path}: ${typeof value} is not JSON-compatible`);
}
