import { cp, mkdir, readFile, readdir, rm, access } from 'node:fs/promises';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

const rootDir = __dirname;
const publicDir = resolve(rootDir, 'public');
const htmlEntry = resolve(publicDir, 'index.html');
const distDir = resolve(rootDir, 'dist');

function servePublicIndex(): Plugin {
  return {
    name: 'serve-public-index',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url?.split('?')[0];
        if (requestUrl !== '/') {
          next();
          return;
        }

        try {
          const html = await readFile(htmlEntry, 'utf8');
          const transformed = await server.transformIndexHtml('/', html);
          res.setHeader('Content-Type', 'text/html');
          res.end(transformed);
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}

function copyPublicAssets(): Plugin {
  return {
    name: 'copy-public-assets',
    apply: 'build',
    async closeBundle() {
      const entries = await readdir(publicDir, { withFileTypes: true });
      await mkdir(distDir, { recursive: true });

      for (const entry of entries) {
        if (entry.name === 'index.html') {
          continue;
        }

        await cp(resolve(publicDir, entry.name), resolve(distDir, entry.name), {
          force: true,
          recursive: true,
        });
      }

      const builtIndexDir = resolve(distDir, 'public');
      const builtIndexPath = resolve(builtIndexDir, 'index.html');

      // If the build emitted `public/index.html` (when input path includes
      // the `public` directory), move it to the dist root. If the built
      // `index.html` is already at the dist root, nothing needs to be done.
      try {
        await access(builtIndexPath);
        await cp(builtIndexPath, resolve(distDir, 'index.html'), { force: true });
        await rm(builtIndexDir, { force: true, recursive: true });
      } catch (err) {
        // builtIndexPath doesn't exist — assume Vite emitted index.html to
        // the dist root already, so nothing to copy.
      }
    },
  };
}

export default defineConfig({
  publicDir: 'public',
  plugins: [servePublicIndex(), copyPublicAssets()],
  resolve: {
    alias: {
      '@': resolve(rootDir, './src'),
      '@core': resolve(rootDir, './src/core'),
      '@services': resolve(rootDir, './src/services'),
      '@components': resolve(rootDir, './src/components'),
    },
  },
  esbuild: {
    keepNames: true
  },
  optimizeDeps: {
    esbuildOptions: {
      keepNames: true
    }
  },
  build: {
    copyPublicDir: false,
    outDir: distDir,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: htmlEntry,
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      // Forward legacy CGI path to local FastAPI adapter during development
      // Legacy frontend calls the CGI path; during dev forward these to the
      // import-based FastAPI adapter so the frontend works without changing
      // the client code. If you prefer the subprocess adapter, point this
      // to `/cgiserver` instead.
      '/ncplot7py/scripts/cgiserver.cgi': {
        // During local development route to the import adapter on 8001
        target: 'http://localhost:8001',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace('/ncplot7py/scripts/cgiserver.cgi', '/cgiserver_import'),
      },
      // Also provide path for the import-based adapter
      '/ncplot7py/scripts/cgiserver_import': {
        target: 'http://localhost:8001/cgiserver_import',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace('/ncplot7py/scripts/cgiserver_import', '/cgiserver_import'),
      },
    },
  },
});
