import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'c8',
    },
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@core': path.resolve(__dirname, './src/core'),
      '@domain': path.resolve(__dirname, './src/domain'),
      '@services': path.resolve(__dirname, './src/services'),
      '@components': path.resolve(__dirname, './src/components'),
      '@adapters': path.resolve(__dirname, './src/adapters'),
      '@workers': path.resolve(__dirname, './src/workers'),
    },
  },
});
