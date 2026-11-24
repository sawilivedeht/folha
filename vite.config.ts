import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

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
  plugins: [producao()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.alethe/**', '.claude/**', 'android/**', 'dist/**', 'e2e/**'] },
});
