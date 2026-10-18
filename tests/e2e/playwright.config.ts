import { defineConfig } from '@playwright/test';

const registryPort = process.env.E2E_REGISTRY_PORT ?? '18082';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The Contract Registry, a separate Go service (ADR-0013). The script creates
      // the E2E database first.
      command: 'bash start-registry.sh',
      url: `http://localhost:${registryPort}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
