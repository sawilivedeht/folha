import { defineConfig, devices } from '@playwright/test';

const PORT = 4318;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'pt-BR',
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
    {
      name: 'celular pequeno',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 640 },
        screen: { width: 360, height: 640 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4'] } },
  ],
});
