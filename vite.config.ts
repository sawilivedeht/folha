import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm'] as const;

const PDFJS_MIME_TYPES: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function resolvePdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  for (const specifier of ['pdfjs-dist/package.json', 'pdfjs-dist/build/pdf.mjs']) {
    try {
      const resolved = require.resolve(specifier);
      const dir = specifier.endsWith('package.json') ? dirname(resolved) : resolve(dirname(resolved), '..');
      if (existsSync(join(dir, 'cmaps'))) return dir;
    } catch {
      // Tenta o próximo especificador ou busca em node_modules.
    }
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', 'pdfjs-dist');
    if (existsSync(join(candidate, 'cmaps'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Assets do pdfjs-dist não encontrados em node_modules.');
}

/**
 * Copia cmaps, fontes padrão e módulos WASM do pdfjs-dist para `dist/pdfjs/` no build
 * e serve os mesmos caminhos em `/pdfjs/` durante o desenvolvimento.
 */
function pdfjsAssets(): Plugin {
  let outDir = 'dist';
  let isBuild = false;

  return {
    name: 'folha-pdfjs-assets',
    configResolved(config) {
      isBuild = config.command === 'build';
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      let cachedRoot: string | null = null;
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const urlPath = (req.url ?? '').split('?')[0];
        const rel = urlPath.replace(/^\/+/, '');
        const topDir = rel.split('/')[0];
        if (!PDFJS_ASSET_DIRS.includes(topDir as (typeof PDFJS_ASSET_DIRS)[number])) {
          next();
          return;
        }
        cachedRoot ??= resolvePdfjsRoot();
        const allowedRoot = resolve(cachedRoot, topDir);
        const filePath = resolve(cachedRoot, rel);
        if (!filePath.startsWith(`${allowedRoot}/`) && !filePath.startsWith(`${allowedRoot}\\`)) {
          next();
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        const ext = extname(filePath).toLowerCase();
        res.setHeader('Content-Type', PDFJS_MIME_TYPES[ext] ?? 'application/octet-stream');
        res.end(readFileSync(filePath));
      });
    },
    writeBundle() {
      if (!isBuild) return;
      const pdfjsRoot = resolvePdfjsRoot();
      for (const sub of PDFJS_ASSET_DIRS) {
        const src = join(pdfjsRoot, sub);
        if (!existsSync(src)) continue;
        cpSync(src, join(outDir, 'pdfjs', sub), { recursive: true, force: true });
      }
    },
  };
}

/**
 * Só no build: tira da CSP o nonce que existe apenas para o servidor de desenvolvimento injetar CSS,
 * e leva os avisos de licença de terceiros junto do app (pdf.js é Apache-2.0, que exige o aviso).
 */
function producao(): Plugin {
  return {
    name: 'folha-producao',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(" 'nonce-folha-vite-dev'", '').replace(/\s*<meta property="csp-nonce"[^>]*>/, '');
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.md',
        source: readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [producao(), pdfjsAssets()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.alethe/**', '.claude/**', 'android/**', 'dist/**', 'e2e/**'] },
});
