// Vazamentos: heap JS, nós do DOM, listeners e object URLs depois de abrir/fechar o leitor e de virar muitas páginas.
// Medições via CDP (Performance.getMetrics + HeapProfiler.collectGarbage). Os limites têm folga para ruído do
// navegador, mas pegam um vazamento por ciclo (que cresceria linearmente com as repetições).
import { test, expect, abrirEstante, abrirLivro, importarEFechar, mostrarHud } from './helpers';
import type { Page, CDPSession } from '@playwright/test';

interface Medida {
  heapMB: number;
  nos: number;
  listeners: number;
  documentos: number;
  urlsVivas: number;
}

declare global {
  interface Window {
    __urls?: Set<string>;
  }
}

async function instrumentarUrls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vivas = new Set<string>();
    window.__urls = vivas;
    const criar = URL.createObjectURL.bind(URL);
    const revogar = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const u = criar(o);
      vivas.add(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => {
      vivas.delete(u);
      revogar(u);
    };
  });
}

async function medir(page: Page, cdp: CDPSession): Promise<Medida> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const urlsVivas = await page.evaluate(() => window.__urls?.size ?? 0);
  return {
    heapMB: m.JSHeapUsedSize / 1024 / 1024,
    nos: m.Nodes,
    listeners: m.JSEventListeners,
    documentos: m.Documents,
    urlsVivas,
  };
}

function fmt(m: Medida): string {
  return `heap ${m.heapMB.toFixed(2)} MB, nós ${m.nos}, listeners ${m.listeners}, documentos ${m.documentos}, object URLs vivas ${m.urlsVivas}`;
}

/** Object URLs vivas que a página realmente usa (imagens com src blob:) e as que estão registradas como vivas. */
async function urlsEmUso(page: Page): Promise<{ vivas: number; usadas: number }> {
  return page.evaluate(() => ({
    vivas: window.__urls!.size,
    usadas: new Set(Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).map((i) => i.src)).size,
  }));
}

async function voltarParaEstante(page: Page): Promise<void> {
  await page.goBack();
  await expect(page.locator('.lib-page')).toBeVisible();
}

test.describe('Vazamentos', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await instrumentarUrls(page);
  });

  test('abrir e fechar o leitor 30 vezes não acumula nós, listeners nem object URLs', async ({ page }, info) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    const titulo = /Livro EPUB Três/;

    const ciclo = async (): Promise<void> => {
      await abrirLivro(page, titulo);
      await voltarParaEstante(page);
    };
    // Aquecimento: JIT, caches e capa da estante entram no estado estável.
    for (let i = 0; i < 3; i++) await ciclo();
    const base = await medir(page, cdp);
    for (let i = 0; i < 30; i++) await ciclo();
    const fim = await medir(page, cdp);

    const resumo = `base: ${fmt(base)}\nfim:  ${fmt(fim)}`;
    console.log(`[${info.project.name}] 30 aberturas\n${resumo}`);
    info.annotations.push({ type: 'memória', description: resumo.replace(/\n/g, ' | ') });
    expect(fim.nos - base.nos, `nós\n${resumo}`).toBeLessThan(60);
    expect(fim.listeners - base.listeners, `listeners\n${resumo}`).toBeLessThan(30);
    expect(fim.documentos - base.documentos, `documentos\n${resumo}`).toBeLessThanOrEqual(1);
    expect(fim.heapMB - base.heapMB, `heap\n${resumo}`).toBeLessThan(4);
    // Nenhuma object URL fica viva sem uma imagem usando-a, e o total não cresce com as aberturas.
    const u = await urlsEmUso(page);
    expect(u.vivas - u.usadas, `object URLs órfãs\n${resumo}`).toBe(0);
    expect(fim.urlsVivas - base.urlsVivas, `object URLs\n${resumo}`).toBe(0);
  });

  test('sair do leitor revoga as object URLs das imagens do capítulo', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    await abrirLivro(page, /Livro EPUB Três/);
    const dentro = await urlsEmUso(page);
    expect(dentro.usadas, 'o capítulo 1 tem uma imagem').toBeGreaterThanOrEqual(1);
    expect(dentro.vivas).toBe(dentro.usadas);
    await voltarParaEstante(page);
    // Toda object URL viva está em uso por uma imagem da estante (capas); nenhuma sobra do leitor.
    await expect.poll(async () => {
      const u = await urlsEmUso(page);
      return u.vivas - u.usadas;
    }).toBe(0);
  });

  test('trocar de capítulo repetidas vezes revoga as imagens do capítulo anterior', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    await abrirLivro(page, /Livro EPUB Três/);
    await mostrarHud(page);
    for (let i = 0; i < 12; i++) {
      await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
      await page.locator('.reader-toc-item').nth(i % 2 === 0 ? 1 : 0).click();
      await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
      await mostrarHud(page);
    }
    // Nenhuma object URL fica viva sem uma imagem usando-a (as dos capítulos anteriores foram revogadas).
    await expect.poll(async () => {
      const u = await urlsEmUso(page);
      return u.vivas - u.usadas;
    }).toBe(0);
  });

  test('virar páginas e trocar de capítulo muitas vezes não faz o DOM nem os listeners crescerem', async ({ page }, info) => {
    test.skip(!process.env.ESTRESSE, 'pesado: defina ESTRESSE=1');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await abrirEstante(page);
    await importarEFechar(page, ['longo.txt']);
    await abrirLivro(page, 'O Grande Livro de Teste');
    await mostrarHud(page);

    const virar = async (n: number): Promise<void> => {
      await page.evaluate(async (vezes) => {
        const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        for (let i = 0; i < vezes; i++) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await raf();
        }
      }, n);
    };
    // Termina sempre no capítulo 1, para comparar medidas do mesmo capítulo.
    const trocarCapitulos = async (n: number): Promise<void> => {
      for (let i = 0; i <= n; i++) {
        await mostrarHud(page);
        await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
        await page.locator('.reader-toc-item').nth(i === n ? 0 : i % 4).click();
        await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
      }
    };

    await trocarCapitulos(8);
    await virar(60);
    await trocarCapitulos(8);
    const base = await medir(page, cdp);
    await virar(500);
    await trocarCapitulos(50);
    const fim = await medir(page, cdp);

    const resumo = `base: ${fmt(base)}\nfim:  ${fmt(fim)}`;
    console.log(`[${info.project.name}] 500 páginas + 50 capítulos\n${resumo}`);
    info.annotations.push({ type: 'memória', description: resumo.replace(/\n/g, ' | ') });
    expect(fim.nos - base.nos, `nós\n${resumo}`).toBeLessThan(150);
    expect(fim.listeners - base.listeners, `listeners\n${resumo}`).toBeLessThan(30);
    expect(fim.heapMB - base.heapMB, `heap\n${resumo}`).toBeLessThan(3);
  });
});
