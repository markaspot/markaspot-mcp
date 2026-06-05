import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure unit tests, no DOM. All network is mocked; nothing should hit a real
    // backend.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file controls its own module/env state and resets the cached
    // registries in beforeEach, so isolate per file to avoid cache leaks.
    clearMocks: true,
    restoreMocks: true,
  },
});
