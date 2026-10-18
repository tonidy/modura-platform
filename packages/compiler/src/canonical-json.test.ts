import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.ts';

describe('canonicalJson', () => {
  it('sorts keys by code unit at every depth, independent of insertion order', () => {
    const a = canonicalJson({ b: 1, a: { y: true, x: null }, B: 'upper' });
    const b = canonicalJson({ a: { x: null, y: true }, B: 'upper', b: 1 });

    expect(a).toBe(b);
    // Uppercase sorts before lowercase in code-unit order, regardless of locale.
    expect(Object.keys(JSON.parse(a))).toEqual(['B', 'a', 'b']);
  });

  it('keeps array order, drops undefined properties and ends with a newline', () => {
    expect(canonicalJson({ list: [3, 1, 2], gone: undefined })).toBe(
      '{\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n',
    );
  });

  it('puts integer-like keys first in numeric order, as JavaScript always does', () => {
    const output = canonicalJson({ description: 'x', 404: 'b', 200: 'a', 1000: 'c' });

    expect(Object.keys(JSON.parse(output))).toEqual(['200', '404', '1000', 'description']);
    expect(output).toBe(canonicalJson({ 1000: 'c', 200: 'a', description: 'x', 404: 'b' }));
  });

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/not valid JSON/);
    expect(() => canonicalJson([undefined])).toThrow(/not JSON-compatible/);
  });
});
