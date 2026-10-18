import { defineModule } from '@modura/schema';
import { describe, expect, it } from 'vitest';
import { serviceOfModule, type ModuraConfig } from './config.ts';

const module = (name: string) =>
  defineModule({ name, version: '0.1.0', description: 'Test.', permissions: {}, operations: {} });

function config(services: ModuraConfig['services']): ModuraConfig {
  return {
    modules: [module('sales'), module('reports')],
    api: { title: 'Test', version: '0.0.0' },
    services,
    outputs: { ir: 'ir.json', mcp: 'tools.json', sdk: 'sdk.ts' },
  };
}

describe('serviceOfModule', () => {
  it('maps every module to the one service that owns it', () => {
    const services = config({
      go: { modules: ['sales'], openapi: 'go.json' },
      py: { modules: ['reports'], openapi: 'py.json' },
    });

    expect(serviceOfModule(services)).toEqual({ sales: 'go', reports: 'py' });
  });

  it('refuses a module owned twice, a module owned by nobody, and an unknown module', () => {
    const broken = config({
      go: { modules: ['sales', 'catalog'], openapi: 'go.json' },
      py: { modules: ['sales'], openapi: 'py.json' },
    });

    expect(() => serviceOfModule(broken)).toThrow(
      'modura.config.ts services: module sales is in both go and py; module reports belongs to no service; service lists unknown module catalog',
    );
  });
});
