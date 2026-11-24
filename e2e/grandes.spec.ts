// Livros grandes: tempos de importação, abertura, virada de página (média e p95) e pulo pelo sumário, e o espaço
// ocupado no IndexedDB. Pesado: só roda com ESTRESSE=1. Os limites são largos (pegam regressões grosseiras);
// os números reais saem no console e nas anotações do relatório.
import { test, expect, abrirEstante, esperarLeitor, fecharModal, mostrarHud } from './helpers';
import type { Page } from '@playwright/test';
// @ts-expect-error módulo .mjs sem declarações de tipos
import { epubCapituloUnico, epubGrande, txtGrande } from './fixtures/grandes.mjs';

test.skip(!process.env.ESTRESSE, 'pesado: defina ESTRESSE=1');
test.describe.configure({ mode: 'serial' });

interface Livro {
  nome: string;
  arquivo: { name: string; mimeType: string; buffer: Buffer };
  titulo: string;
  /** Texto que identifica o capítulo-alvo do pulo pelo sumário (null = sem sumário útil). */
  capituloAlvo: { indice: number; texto: string } | null;
  /** Capítulo (índice no sumário) onde a leitura fica antes de medir a abertura: abrir "no meio" é o caso real. */
  capituloPreparo: number | null;
  limites: { importarMs: number; abrirMs: number; p95Ms: number; pularMs: number };
}

const livros: Livro[] = [
  {
    nome: 'TXT de 5 MB',
    arquivo: { name: 'grande.txt', mimeType: 'text/plain', buffer: null as unknown as Buffer },
    titulo: 'Livro Enorme de Teste',
    capituloAlvo: { indice: 41, texto: 'Capítulo 41' },
    capituloPreparo: 21,
    limites: { importarMs: 60_000, abrirMs: 5000, p95Ms: 120, pularMs: 3000 },
  },
  {
    nome: 'EPUB com 300 capítulos e 200 imagens',
    arquivo: { name: 'grande.epub', mimeType: 'application/epub+zip', buffer: null as unknown as Buffer },
    titulo: 'Epub Gigante de Teste',
    capituloAlvo: { indice: 250, texto: 'Capítulo 251' },
    capituloPreparo: 120,
    limites: { importarMs: 60_000, abrirMs: 5000, p95Ms: 120, pularMs: 3000 },
  },
  {
    nome: 'capítulo único de 400 mil caracteres',
    arquivo: { name: 'unico.epub', mimeType: 'application/epub+zip', buffer: null as unknown as Buffer },
    titulo: 'Capitulo Unico de Teste',
    capituloAlvo: null,
    capituloPreparo: null,
    limites: { importarMs: 30_000, abrirMs: 5000, p95Ms: 120, pularMs: 3000 },
  },
];

function gerar(l: Livro): Buffer {
  if (l.nome.startsWith('TXT')) return txtGrande(5 * 1024 * 1024);
  if (l.nome.startsWith('EPUB')) return epubGrande(300, 200);
  return epubCapituloUnico(400_000);
}

async function usoArmazenamento(page: Page): Promise<number> {
  return page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
}

function percentil(valores: number[], p: number): number {
  const o = valores.slice().sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

for (const livro of livros) {
  test(`livro grande: ${livro.nome}`, async ({ page }, info) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // CPU_THROTTLE=4 simula um aparelho ~4x mais lento (mais próximo de um Android de entrada).
    const lentidao = Number(process.env.CPU_THROTTLE ?? 1);
    if (lentidao > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: lentidao });
    }
    await abrirEstante(page);
    const usoAntes = await usoArmazenamento(page);

    // Importação.
    livro.arquivo.buffer = gerar(livro);
    const tamanhoArquivo = livro.arquivo.buffer.length;
    const t0 = Date.now();
    await page.locator('input[type=file]').setInputFiles(livro.arquivo);
    await expect(page.locator('.lib-modal-title', { hasText: /^Importando/ })).toHaveCount(0, { timeout: 120_000 });
    const importarMs = Date.now() - t0;
    await fecharModal(page);
    await expect(page.locator('.lib-card', { hasText: livro.titulo })).toHaveCount(1);
    const usoDepois = await usoArmazenamento(page);
    const idbMB = (usoDepois - usoAntes) / 1024 / 1024;

    // Deixa a leitura no meio do livro e volta à estante, para medir a reabertura na posição salva.
    await page.locator('.lib-card', { hasText: livro.titulo }).first().click();
    await esperarLeitor(page);
    await mostrarHud(page);
    if (livro.capituloPreparo !== null) {
      await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
      await page.locator('.reader-toc-item').nth(livro.capituloPreparo).click();
    } else {
      await page.locator('.reader-slider').evaluate((el: HTMLInputElement) => {
        el.value = '500';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await esperarLeitor(page);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();

    // Abertura: do toque no cartão até a primeira página pintada.
    const abrirMs = await page.evaluate(
      (titulo) =>
        new Promise<number>((resolve, reject) => {
          const card = Array.from(document.querySelectorAll<HTMLElement>('.lib-card')).find((c) => c.textContent?.includes(titulo))!;
          const t = performance.now();
          const timeout = setTimeout(() => reject(new Error('leitor não abriu')), 30_000);
          const obs = new MutationObserver(() => {
            const st = document.querySelector('.reader-status-page')?.textContent ?? '';
            if (/Pág\. \d+ de \d+/.test(st) && document.querySelector('.reader-columns')?.firstElementChild) {
              obs.disconnect();
              requestAnimationFrame(() => {
                clearTimeout(timeout);
                resolve(performance.now() - t);
              });
            }
          });
          obs.observe(document.body, { childList: true, subtree: true, characterData: true });
          card.click();
        }),
      livro.titulo,
    );
    await esperarLeitor(page);

    // Virada de página: 100 viradas, cada uma do keydown ao quadro seguinte.
    const tempos = await page.evaluate(async () => {
      const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const out: number[] = [];
      await raf();
      for (let i = 0; i < 100; i++) {
        const t = performance.now();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        void document.querySelector<HTMLElement>('.reader-columns')!.getBoundingClientRect();
        await raf();
        out.push(performance.now() - t);
      }
      return out;
    });
    const media = tempos.reduce((a, b) => a + b, 0) / tempos.length;
    const p95 = percentil(tempos, 95);

    // Pulo pelo sumário (ou pela barra de progresso, no livro de capítulo único).
    let pularMs: number;
    await mostrarHud(page);
    if (livro.capituloAlvo) {
      const alvo = livro.capituloAlvo;
      await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
      const item = page.locator('.reader-toc-item').nth(alvo.indice);
      await item.scrollIntoViewIfNeeded();
      const caixa = (await item.boundingBox())!;
      pularMs = await page.evaluate(
        ({ i, texto }) =>
          new Promise<number>((resolve, reject) => {
            const t = performance.now();
            const timeout = setTimeout(() => reject(new Error('pulo não concluiu')), 20_000);
            const obs = new MutationObserver(() => {
              const h = document.querySelector('.reader-columns')?.textContent ?? '';
              if (h.includes(texto)) {
                obs.disconnect();
                requestAnimationFrame(() => {
                  clearTimeout(timeout);
                  resolve(performance.now() - t);
                });
              }
            });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            document.querySelectorAll<HTMLElement>('.reader-toc-item')[i].click();
          }),
        { i: alvo.indice, texto: alvo.texto },
      );
      expect(caixa.height).toBeGreaterThan(0);
    } else {
      pularMs = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const slider = document.querySelector<HTMLInputElement>('.reader-slider')!;
            const antes = document.querySelector('.reader-status-page')!.textContent;
            const t = performance.now();
            slider.value = '700';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
            const esperar = (): void => {
              if (document.querySelector('.reader-status-page')!.textContent !== antes) {
                requestAnimationFrame(() => resolve(performance.now() - t));
              } else requestAnimationFrame(esperar);
            };
            esperar();
          }),
      );
    }

    const paginas = (await page.locator('.reader-status-page').textContent())!.match(/de (\d+)/)![1];
    const resumo =
      `arquivo ${(tamanhoArquivo / 1024 / 1024).toFixed(2)} MB; importar ${importarMs} ms; IndexedDB +${idbMB.toFixed(1)} MB; ` +
      `abrir ${abrirMs.toFixed(0)} ms; virar: média ${media.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, máx ${Math.max(...tempos).toFixed(1)} ms; ` +
      `pular ${pularMs.toFixed(0)} ms; ${paginas} páginas no capítulo aberto`;
    console.log(`[${info.project.name}] ${livro.nome}: ${resumo}`);
    info.annotations.push({ type: 'grandes', description: `${livro.nome}: ${resumo}` });

    expect(importarMs, resumo).toBeLessThan(livro.limites.importarMs);
    expect(abrirMs, resumo).toBeLessThan(livro.limites.abrirMs);
    expect(p95, resumo).toBeLessThan(livro.limites.p95Ms);
    expect(pularMs, resumo).toBeLessThan(livro.limites.pularMs);
  });
}
