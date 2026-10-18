import fc from 'fast-check';
import { canonicalJson, compile, type IrDocument } from '@modura/compiler';
import { contractArbitrary } from '@modura/compiler/testing';
import { generateMcpTools } from '@modura/generator-mcp';
import { generateOpenApi } from '@modura/generator-openapi';
import { generateSdk } from '@modura/generator-sdk-ts';
import { describe, expect, it } from 'vitest';

// Every generator must handle every valid contract (plan M6). The CLI package is the
// one place that depends on all of them, so the property lives here.
fc.configureGlobal({
  seed: Number(process.env.FC_SEED ?? 20261011),
  numRuns: Number(process.env.FC_RUNS ?? 100),
});

describe('generators on random contracts', () => {
  it('never throw, and always produce deterministic output', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const ir = JSON.parse(canonicalJson(compile(modules))) as IrDocument;
        const openapi = canonicalJson(generateOpenApi(ir, { title: 'Random', version: '0.0.0' }));
        const sdk = generateSdk(ir);
        const tools = generateMcpTools(ir);

        expect(canonicalJson(generateOpenApi(ir, { title: 'Random', version: '0.0.0' }))).toBe(openapi);
        expect(generateSdk(ir)).toBe(sdk);
        expect(JSON.stringify(tools)).not.toContain('$ref');
        expect(tools.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
      }),
    );
  });

  it('give every event a payload component and an SDK type', () => {
    fc.assert(
      fc.property(contractArbitrary, (modules) => {
        const ir = JSON.parse(canonicalJson(compile(modules))) as IrDocument;
        const openapi = generateOpenApi(ir, { title: 'Random', version: '0.0.0' }) as any;
        const sdk = generateSdk(ir);
        for (const [module, definition] of Object.entries(ir.modules)) {
          for (const event of Object.keys(definition.events)) {
            const name = `${module[0]!.toUpperCase()}${module.slice(1)}${event[0]!.toUpperCase()}${event.slice(1)}Event`;
            expect(openapi.components.schemas[name]?.['x-modura-event']).toBe(`${module}.${event}`);
            expect(sdk).toMatch(new RegExp(`export (interface|type) ${name}\\b`));
          }
        }
      }),
    );
  });
});
