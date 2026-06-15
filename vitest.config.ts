import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest configuration kept separate from vite.config.ts so the Tauri build
// config stays untouched. Default test environment is `node` (fast, for pure
// logic); files that need a DOM opt in per-file with `// @vitest-environment jsdom`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
