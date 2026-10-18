import { compile, type IrDocument } from '@modura/compiler';
import { calculator, tape } from '@modura/example-calculator';
import { describe, expect, it } from 'vitest';
import { generateMcpTools } from './index.ts';

const ir = compile([calculator, tape]);

describe('generateMcpTools', () => {
  it('exposes only the read operations, all marked read-only', () => {
    const { tools } = generateMcpTools(ir);

    expect(tools.map((tool) => tool.name)).toEqual(['calculator_evaluate', 'calculator_recall', 'tape_list']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('inlines every schema so a client needs nothing else', () => {
    const recall = generateMcpTools(ir).tools.find((tool) => tool.name === 'calculator_recall');

    expect(JSON.stringify(recall)).not.toContain('$ref');
    expect(recall?.inputSchema).toMatchObject({
      type: 'object',
      required: ['slot'],
      properties: { slot: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' } },
    });
    expect(recall?.outputSchema).toMatchObject({ type: 'object', required: ['result', 'slot', 'storedAt'] });
    expect(recall?._meta).toEqual({
      'modura/operation': 'calculator.recall',
      'modura/requires': ['calculator.use'],
    });
  });

  it('refuses to turn a command into a tool even if the IR was tampered with', () => {
    const store = ir.modules.calculator!.operations.store!;
    const tampered: IrDocument = {
      ...ir,
      modules: {
        ...ir.modules,
        calculator: {
          ...ir.modules.calculator!,
          operations: { store: { ...store, expose: { mcp: true } } },
        },
      },
    };

    expect(() => generateMcpTools(tampered)).toThrow(/calculator\.store is a command/);
  });

  it('names the service that answers each tool', () => {
    const { tools } = generateMcpTools(ir, { services: { calculator: 'calc-go', tape: 'tape-py' } });
    const service = (name: string) => tools.find((tool) => tool.name === name)?._meta['modura/service'];

    expect(service('calculator_evaluate')).toBe('calc-go');
    expect(service('tape_list')).toBe('tape-py');
  });
});
