import type { ModuraConfig } from '@modura/cli';
import { registry } from '@modura/module-registry';

const config: ModuraConfig = {
  modules: [registry],
  api: { title: 'Modura Contract Registry API', version: '1.0.0-rc.5' },
  services: {
    'registry-go': {
      modules: ['registry'],
      openapi: 'generated/openapi/registry-go.json',
    },
  },
  // This repository keeps its release history in git (plan M8). The server registry
  // runs as its own service (apps/registry-go); pass --registry http://... to use it.
  registry: 'file:contracts/releases',
  outputs: {
    ir: 'generated/ir/modura.ir.json',
    mcp: 'generated/mcp/tools.json',
    sdk: 'packages/cli/src/generated/registry-client.ts',
  },
};

export default config;
