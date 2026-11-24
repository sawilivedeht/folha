// Privacidade e funcionamento offline: um uso completo do app não pode gerar nenhuma requisição para fora
// de localhost, e o pdf.js (o maior pedaço do bundle) só é baixado quando um PDF é importado.
import type { Page, Request } from '@playwright/test';
import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  abrirConfig,
  fecharConfig,
  mostrarHud,
  tocar,
  estado,
  aguardarAssentar,
  lerIndexedDB,
} from './helpers';

interface Registro {
  /** Tudo o que tentou sair de localhost (requisições, websockets, janelas, navegações). */
  externas: string[];
  /** Requisições locais, em ordem. */
  locais: Request[];
  workers: string[];
}

function ehLocal(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') return true;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

async function registrarRede(page: Page): Promise<Registro> {
  const r: Registro = { externas: [], locais: [], workers: [] };
  const ctx = page.context();
  await ctx.route(/.*/, (route) => {
    if (ehLocal(route.request().url())) return route.fallback();
    r.externas.push(`${route.request().method()} ${route.request().url()} (${route.request().resourceType()})`);
    return route.abort('blockedbyclient');
  });
  ctx.on('request', (req) => {
    if (ehLocal(req.url())) r.locais.push(req);
    else if (!r.externas.some((e) => e.includes(req.url()))) r.externas.push(`request ${req.url()}`);
  });
  ctx.on('page', (p) => r.externas.push(`nova janela: ${p.url()}`));
  page.on('websocket', (ws) => {
    if (!ehLocal(ws.url())) r.externas.push(`websocket ${ws.url()}`);
  });
  page.on('framenavigated', (f) => {
    if (!ehLocal(f.url())) r.externas.push(`navegação ${f.url()}`);
  });
  page.on('worker', (w) => r.workers.push(w.url()));
  return r;
}

/** Chunk do pdf.js (pdf-<hash>.js) e o worker dele (pdf.worker.min-<hash>.mjs). */
const PDFJS = /\/assets\/pdf(?:\.worker\.min)?-[\w-]+\.m?js$/;
const urlsPdfjs = (r: Registro) => r.locais.map((q) => q.url()).filter((u) => PDFJS.test(new URL(u).pathname));

test.describe('Offline e privacidade', () => {
  test('uso completo (importar PDF/EPUB/TXT, ler, ajustes, marcador, excluir) não faz nenhuma requisição externa', async ({ page }) => {
    const rede = await registrarRede(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);
    test.info().annotations.push({ type: 'abertura', description: rede.locais.map((q) => new URL(q.url()).pathname).join(' ') });
    expect(urlsPdfjs(rede), 'pdf.js não pode ser carregado na abertura').toEqual([]);

    // EPUB e TXT: leitura, ajustes e marcador, ainda sem pdf.js.
    await importarEFechar(page, ['epub3.epub', 'longo.txt']);
    await abrirLivro(page, 'Livro EPUB Três');
    await tocar(page, 0.85);
    await tocar(page, 0.85);
    expect((await estado(page)).pagina).toBeGreaterThan(1);
    await abrirConfig(page);
    await page.getByRole('button', { name: 'A+, aumentar fonte' }).click();
    await page.locator('.reader-theme-btn--dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fecharConfig(page);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.locator('.reader-toc-item').nth(2).click();
    await aguardarAssentar(page);
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();
    await abrirLivro(page, 'O Grande Livro de Teste');
    await tocar(page, 0.85);
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(urlsPdfjs(rede), 'EPUB/TXT não podem puxar o pdf.js').toEqual([]);
    expect(rede.workers, 'nenhum worker antes do PDF').toEqual([]);

    // PDF: agora sim o pdf.js e o worker dele são carregados, do próprio app (sem CDN).
    await importarEFechar(page, ['texto.pdf']);
    const pdfjs = urlsPdfjs(rede);
    expect(pdfjs.some((u) => /\/pdf-[\w-]+\.js$/.test(u)), `chunk do pdf.js carregado: ${pdfjs.join(', ')}`).toBe(true);
    expect(pdfjs.some((u) => /\/pdf\.worker\.min-[\w-]+\.mjs$/.test(u)), 'worker do pdf.js carregado').toBe(true);
    expect(rede.workers.some((u) => PDFJS.test(new URL(u).pathname)), `worker real criado: ${rede.workers.join(', ')}`).toBe(true);
    test.info().annotations.push({ type: 'pdf.js preguiçoso', description: pdfjs.map((u) => new URL(u).pathname).join(' ') });

    await abrirLivro(page, 'PDF de Texto');
    await tocar(page, 0.85);
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();

    // Excluir.
    await expect(page.locator('.lib-card')).toHaveCount(3);
    await page.locator('.lib-card', { hasText: 'Livro EPUB Três' }).getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    await page.locator('.lib-modal .lib-btn-danger').click();
    await expect(page.locator('.lib-card')).toHaveCount(2);
    expect(await lerIndexedDB<string[]>(page, 'meta')).toHaveLength(2);

    // Nada saiu de localhost; tudo o que foi baixado é do próprio app.
    expect(rede.externas, 'requisições para fora de localhost').toEqual([]);
    const origem = new URL(page.url()).origin;
    for (const q of rede.locais) {
      const u = new URL(q.url());
      if (u.protocol === 'blob:' || u.protocol === 'data:') continue;
      expect(u.origin, `requisição de outra origem: ${q.url()}`).toBe(origem);
    }
    const tipos = new Set(rede.locais.map((q) => q.resourceType()));
    expect([...tipos].filter((t) => ['xhr', 'fetch', 'websocket', 'eventsource', 'ping'].includes(t)), 'o app não faz chamadas de rede').toEqual([]);
    test.info().annotations.push({ type: 'total', description: `${rede.locais.length} requisições locais, 0 externas` });
  });
});
