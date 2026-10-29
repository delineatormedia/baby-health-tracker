/// <reference types="vitest/config" />
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      // Single-page app: the server serves index.html for every route, the client does the rest.
      adapter: adapter({ fallback: 'index.html' }),
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
