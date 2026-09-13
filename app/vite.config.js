import { defineConfig } from 'vite';

// Served from GitHub Pages at jspiiv.github.io/charter, so assets resolve under
// /charter/. Routing is hash based, so no 404 fallback is needed.
export default defineConfig({
  base: '/charter/',
  build: { outDir: '../docs', emptyOutDir: true },
});
