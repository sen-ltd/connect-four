import { defineConfig } from 'vite';

export default defineConfig({
  base: '/portfolio/connect-four/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
