import type { ModuraConfig } from '@modura/cli';
import { calculator, tape } from './src/modules/index.ts';

const config: ModuraConfig = {
  modules: [calculator, tape],
  api: { title: 'Calculator', version: '0.1.0' },
  // Two services, so the example has one OpenAPI document per service. Here both run
  // in-process (src/local.ts); in a real system each would be its own server.
  services: {
    calculator: { modules: ['calculator'], openapi: 'generated/openapi/calculator.json' },
    tape: { modules: ['tape'], openapi: 'generated/openapi/tape.json' },
  },
  // The release history, as files in git (Modura's file registry). `modura publish`
  // adds the next release and refuses one that breaks clients without a version bump.
  registry: 'file:contracts/releases',
  outputs: {
    ir: 'generated/ir/modura.ir.json',
    mcp: 'generated/mcp/tools.json',
    sdk: 'src/generated/client.ts',
  },
};

export default config;
