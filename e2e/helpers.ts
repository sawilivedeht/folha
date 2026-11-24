import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR } from './fixtures/make.mjs';

/** Teste base: falha se houver console.error, pageerror ou requisição quebrada durante o teste. */
export const test = base.extend<{ erros: string[] }>({
  erros: [
    async ({ page }, use) => {
      const erros: string[] = [];
      page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') erros.push(`console.error: ${m.text()}`);
      });
      page.on('requestfailed', (req) => {
        const motivo = req.failure()?.errorText ?? 'desconhecido';
        // Navegações (reload/goBack) abortam requisições em andamento de forma legítima.
        if (motivo === 'net::ERR_ABORTED') return;
        erros.push(`requestfailed: ${req.url()} (${motivo})`);
      });
      await use(erros);
      expect(erros, 'erros de console/pageerror/requestfailed').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export function caminho(nome: string): string {
  return join(FIXTURE_DIR, nome);
}

export interface ArquivoMemoria {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function arquivo(nome: string, nomeNoApp = nome): ArquivoMemoria {
  const ext = nome.split('.').pop()!;
  const mime: Record<string, string> = {
    txt: 'text/plain',
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return { name: nomeNoApp, mimeType: mime[ext] ?? 'application/octet-stream', buffer: readFileSync(caminho(nome)) };
}

export async function abrirEstante(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.lib-page')).toBeVisible();
}

/** Importa arquivos pelo input e espera o fim da importação (modal fecha ou mostra resultado). */
export async function importar(page: Page, arquivos: Array<string | ArquivoMemoria>): Promise<void> {
  const itens = arquivos.map((a) => (typeof a === 'string' ? arquivo(a) : a));
  await page.locator('input[type=file]').setInputFiles(itens);
  // Espera a importação terminar: o título do modal deixa de ser "Importando…".
  await expect(page.locator('.lib-modal-title', { hasText: /^Importando/ })).toHaveCount(0, { timeout: 60_000 });
}

export async function fecharModal(page: Page): Promise<void> {
  const fechar = page.locator('.lib-modal button', { hasText: 'Fechar' });
  if (await fechar.count()) await fechar.click();
  await expect(page.locator('.lib-modal')).toHaveCount(0);
}

export async function importarEFechar(page: Page, arquivos: Array<string | ArquivoMemoria>): Promise<void> {
  await importar(page, arquivos);
  await fecharModal(page);
}

/** Garante que o cartão do livro na estante exibiu uma capa <img> carregada (naturalWidth > 0). */
export async function esperarCapaValida(page: Page, titulo: string | RegExp): Promise<void> {
  const card = page.locator('.lib-card', { hasText: titulo }).first();
  await card.scrollIntoViewIfNeeded();
  const img = card.locator('img.lib-cover-img');
  await expect(img, `capa <img> visível para ${String(titulo)}`).toBeVisible();
  await expect(img, `capa usa blob: para ${String(titulo)}`).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(
      () => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : -1)),
      { message: `capa com naturalWidth > 0 para ${String(titulo)}` },
    )
    .toBeGreaterThan(0);
}

/** Abre um livro da estante pelo título e espera a primeira página. */
export async function abrirLivro(page: Page, titulo: string | RegExp): Promise<void> {
  await page.locator('.lib-card', { hasText: titulo }).first().click();
  await esperarLeitor(page);
}

export async function esperarLeitor(page: Page): Promise<void> {
  await expect(page.locator('.reader-columns')).toBeVisible();
  await expect(page.locator('.reader-status-page')).toContainText('Pág.');
  // Espera as imagens da página terminarem de carregar com dados válidos e a paginação assentar.
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.reader-columns img')).every(
        (i) => !i.isConnected || (i.complete && i.naturalWidth > 0 && i.style.visibility !== 'hidden'),
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

export interface EstadoLeitor {
  pagina: number; // 1-based
  total: number;
  percentual: number;
  capitulo: number; // índice (derivado do primeiro bloco / sumário não é exposto: usamos o título do capítulo corrente)
}

export async function estado(page: Page): Promise<{ pagina: number; total: number; percentual: number }> {
  const txt = (await page.locator('.reader-status-page').textContent()) ?? '';
  const m = txt.match(/Pág\. (\d+) de (\d+) · (\d+)%/);
  if (!m) throw new Error(`Status inesperado: ${txt}`);
  return { pagina: Number(m[1]), total: Number(m[2]), percentual: Number(m[3]) };
}

/** Define a fonte clicando em A+/A− (reais) até chegar ao tamanho pedido. */
export async function definirFonte(page: Page, alvo: number): Promise<void> {
  await abrirConfig(page);
  let atual = 0;
  for (let i = 0; i < 40; i++) {
    atual = Number(((await page.locator('.reader-aa-sheet').getByText(/^\d+ px$/).first().textContent()) ?? '0').replace(/\D/g, ''));
    if (atual === alvo) break;
    const btn = page.getByRole('button', { name: atual < alvo ? 'Aumentar fonte' : 'Diminuir fonte' });
    await btn.click();
  }
  expect(atual, `controle de fonte atingiu ${alvo}px`).toBe(alvo);
  await fecharConfig(page);
  await expect
    .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.reader-columns')!).fontSize)))
    .toBe(alvo);
  await aguardarAssentar(page);
}

export async function aguardarAssentar(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => r()), 350)));
}

export async function mostrarHud(page: Page): Promise<void> {
  if (!(await page.locator('.reader.is-hud-open').count())) {
    await tocar(page, 0.5);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
  }
}

export async function abrirConfig(page: Page): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Configurações de leitura' }).click();
  await expect(page.locator('.reader-sheet-overlay--bottom.is-open')).toBeVisible();
}

export async function fecharConfig(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fechar configurações' }).click();
  await expect(page.locator('.reader-sheet-overlay--bottom.is-open')).toHaveCount(0);
  await esconderHud(page);
}

export async function esconderHud(page: Page): Promise<void> {
  if (await page.locator('.reader.is-hud-open').count()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
  }
}

/** Toque na altura média da página, na fração horizontal dada (0..1) da área de leitura. */
export async function tocar(page: Page, fracao: number): Promise<void> {
  const r = await page.locator('.reader-viewport').boundingBox();
  if (!r) throw new Error('viewport ausente');
  await page.touchscreen.tap(r.x + r.width * fracao, r.y + r.height * 0.5);
  await page.evaluate(() => new Promise<void>((res) => setTimeout(res, 60)));
}

export async function deslizar(page: Page, direcao: 'esquerda' | 'direita'): Promise<void> {
  const r = await page.locator('.reader-viewport').boundingBox();
  if (!r) throw new Error('viewport ausente');
  const y = r.y + r.height * 0.5;
  const xa = r.x + r.width * (direcao === 'esquerda' ? 0.8 : 0.2);
  const xb = r.x + r.width * (direcao === 'esquerda' ? 0.2 : 0.8);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: xa, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: xa + ((xb - xa) * i) / 6, y }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.evaluate(() => new Promise<void>((res) => setTimeout(res, 60)));
}

export interface ResultadoPagina {
  violacoes: string[];
  primeiroBloco: number;
  blocosVisiveis: number;
  imagens: number;
  retangulos: number;
}

/** Verifica, dentro do navegador, que tudo o que pertence à página atual cabe na área útil. */
export async function verificarPaginaAtual(page: Page): Promise<ResultadoPagina> {
  return page.evaluate(() => {
    const TOL = 1;
    const viewport = document.querySelector<HTMLElement>('.reader-viewport')!;
    const columns = document.querySelector<HTMLElement>('.reader-columns')!;
    const cs = getComputedStyle(viewport);
    const vr = viewport.getBoundingClientRect();
    const left = vr.left + parseFloat(cs.paddingLeft);
    const right = vr.right - parseFloat(cs.paddingRight);
    const cr = columns.getBoundingClientRect();
    const top = cr.top;
    const bottom = cr.top + columns.clientHeight;
    const gap = parseFloat(getComputedStyle(columns).columnGap) || 0;
    const viol: string[] = [];
    let primeiro = -1;
    let visiveis = 0;
    let nImagens = 0;
    let nRetangulos = 0;

    const dentroHoriz = (cx: number) => cx >= left - gap / 2 && cx <= right + gap / 2;

    const blocos = columns.querySelectorAll<HTMLElement>('[data-i]');
    for (const bloco of blocos) {
      const br = bloco.getBoundingClientRect();
      // pré-filtro: bloco fora da janela horizontal da página (com folga de uma página)
      if (br.right < left - (right - left) - gap || br.left > right + (right - left) + gap) continue;
      const idx = Number(bloco.dataset.i);

      const retangulos: { r: DOMRect; que: string; quebrada?: boolean }[] = [];
      const walker = document.createTreeWalker(bloco, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const pai = n.parentElement!;
        const lh = parseFloat(getComputedStyle(pai).lineHeight);
        for (const r0 of range.getClientRects()) {
          if (r0.width <= 0 || r0.height <= 0) continue;
          // A caixa de conteúdo da fonte pode exceder a caixa de linha (entrelinha < altura natural da fonte);
          // esse excesso é espaço vazio de ascendente/descendente, não glifo cortado.
          const sobra = Number.isFinite(lh) ? Math.max(0, (r0.height - lh) / 2) : 0;
          retangulos.push({ r: new DOMRect(r0.left, r0.top + sobra, r0.width, r0.height - 2 * sobra), que: 'texto' });
        }
      }
      for (const img of bloco.querySelectorAll('img')) {
        const r = img.getBoundingClientRect();
        const quebrada = !img.complete || img.naturalWidth <= 0;
        if (r.width > 0 && r.height > 0) {
          retangulos.push({ r, que: 'imagem', quebrada });
        } else if (quebrada && dentroHoriz((br.left + br.right) / 2)) {
          viol.push(`bloco ${idx}: imagem quebrada (complete=${img.complete}, naturalWidth=${img.naturalWidth})`);
        }
      }

      let temNaPagina = false;
      for (const { r, que, quebrada } of retangulos) {
        const cx = (r.left + r.right) / 2;
        if (!dentroHoriz(cx)) continue;
        temNaPagina = true;
        nRetangulos++;
        if (que === 'imagem') {
          if (quebrada) {
            viol.push(`bloco ${idx}: imagem quebrada (naturalWidth === 0)`);
          } else {
            nImagens++;
          }
        }
        if (r.left < left - TOL || r.right > right + TOL)
          viol.push(`bloco ${idx}: ${que} sai na horizontal (${r.left.toFixed(1)}–${r.right.toFixed(1)} fora de ${left.toFixed(1)}–${right.toFixed(1)})`);
        if (r.top < top - TOL || r.bottom > bottom + TOL)
          viol.push(`bloco ${idx}: ${que} sai na vertical (${r.top.toFixed(1)}–${r.bottom.toFixed(1)} fora de ${top.toFixed(1)}–${bottom.toFixed(1)})`);
      }
      // fonte mínima (ignora sobrescritos, que são marcadores)
      const els = [bloco, ...bloco.querySelectorAll<HTMLElement>('*')];
      for (const e of els) {
        if (e.tagName === 'SUP' || e.tagName === 'IMG' || e.tagName === 'FIGURE' || e.tagName === 'FIGCAPTION') continue;
        if (!e.textContent?.trim()) continue;
        const fs = parseFloat(getComputedStyle(e).fontSize);
        if (fs < 14 - 0.01) viol.push(`bloco ${idx}: fonte de ${fs}px (<14) em <${e.tagName.toLowerCase()}>`);
      }
      if (temNaPagina) {
        visiveis++;
        if (primeiro < 0) primeiro = idx;
      }
    }
    return { violacoes: viol.slice(0, 8), primeiroBloco: primeiro, blocosVisiveis: visiveis, imagens: nImagens, retangulos: nRetangulos };
  });
}

/** Passo (px) entre páginas e total de páginas pelo layout; para a regra "nada escondido entre páginas". */
export async function geometria(page: Page): Promise<{ step: number; pageW: number; gap: number; scrollW: number; total: number }> {
  return page.evaluate(() => {
    const columns = document.querySelector<HTMLElement>('.reader-columns')!;
    const cs = getComputedStyle(columns);
    const pageW = parseFloat(cs.getPropertyValue('width'));
    const gap = parseFloat(cs.columnGap);
    const st = document.querySelector('.reader-status-page')!.textContent ?? '';
    const total = Number(st.match(/de (\d+)/)?.[1] ?? 0);
    return { step: pageW + gap, pageW, gap, scrollW: columns.scrollWidth, total };
  });
}

/**
 * Varredura geométrica do capítulo inteiro de uma vez: todo retângulo de texto/imagem do capítulo
 * deve cair dentro de alguma página (nenhum fica na calha entre páginas nem abaixo da área útil).
 */
export async function varrerCapituloInteiro(page: Page): Promise<{ violacoes: string[]; paginas: number; scrollW: number; step: number }> {
  return page.evaluate(() => {
    const TOL = 1;
    const columns = document.querySelector<HTMLElement>('.reader-columns')!;
    const cs = getComputedStyle(columns);
    const pageW = parseFloat(cs.width);
    const gap = parseFloat(cs.columnGap);
    const step = pageW + gap;
    const cr = columns.getBoundingClientRect();
    const altura = columns.clientHeight;
    const viol: string[] = [];
    const total = Number((document.querySelector('.reader-status-page')!.textContent ?? '').match(/de (\d+)/)?.[1] ?? 0);
    if (total * step + TOL < columns.scrollWidth + gap - 0) viol.push(`páginas×passo (${total}×${step}) < scrollWidth (${columns.scrollWidth})`);

    const checar = (r: DOMRect, rotulo: string) => {
      if (r.width <= 0 || r.height <= 0) return;
      const x0 = r.left - cr.left;
      const x1 = r.right - cr.left;
      const p = Math.floor(((x0 + x1) / 2) / step);
      const ini = p * step;
      if (x0 < ini - TOL || x1 > ini + pageW + TOL) viol.push(`${rotulo}: ${x0.toFixed(1)}–${x1.toFixed(1)} fora da página ${p + 1} (${ini}–${ini + pageW})`);
      if (r.top < cr.top - TOL || r.bottom > cr.top + altura + TOL) viol.push(`${rotulo}: vertical ${r.top - cr.top}–${r.bottom - cr.top} fora de 0–${altura}`);
      if (p >= total) viol.push(`${rotulo}: página ${p + 1} além do total ${total}`);
    };
    const blocos = columns.querySelectorAll<HTMLElement>('[data-i]');
    for (const bloco of blocos) {
      const idx = bloco.dataset.i;
      const walker = document.createTreeWalker(bloco, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const lh = parseFloat(getComputedStyle(n.parentElement!).lineHeight);
        for (const r of range.getClientRects()) {
          const sobra = Number.isFinite(lh) ? Math.max(0, (r.height - lh) / 2) : 0;
          checar(new DOMRect(r.left, r.top + sobra, r.width, r.height - 2 * sobra), `bloco ${idx} texto`);
        }
      }
      for (const img of bloco.querySelectorAll('img')) {
        if (!img.complete || img.naturalWidth <= 0) {
          viol.push(`bloco ${idx}: imagem quebrada (complete=${img.complete}, naturalWidth=${img.naturalWidth})`);
        }
        checar(img.getBoundingClientRect(), `bloco ${idx} imagem`);
      }
      if (viol.length > 8) break;
    }
    return { violacoes: viol.slice(0, 8), paginas: total, scrollW: columns.scrollWidth, step };
  });
}

/** Índice (data-i) do primeiro bloco visível na página, derivado do DOM. */
export async function primeiroBlocoVisivel(page: Page): Promise<number> {
  return (await verificarPaginaAtual(page)).primeiroBloco;
}

export async function blocoVisivel(page: Page, indice: number): Promise<boolean> {
  return page.evaluate((i) => {
    const columns = document.querySelector<HTMLElement>('.reader-columns')!;
    const viewport = document.querySelector<HTMLElement>('.reader-viewport')!;
    const vr = viewport.getBoundingClientRect();
    const el = columns.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.right > vr.left + 1 && r.left < vr.right - 1;
  }, indice);
}

export async function lerIndexedDB<T>(page: Page, loja: string, chave?: string): Promise<T> {
  return page.evaluate(
    ([l, k]) =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open('folha');
        rq.onerror = () => reject(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(l as string, 'readonly');
          const st = tx.objectStore(l as string);
          const q = k ? st.get(k) : st.getAllKeys();
          q.onsuccess = () => {
            db.close();
            resolve(q.result);
          };
          q.onerror = () => reject(q.error);
        };
      }),
    [loja, chave] as [string, string | undefined],
  ) as Promise<T>;
}

/** Índice do primeiro bloco que COMEÇA na página atual (a âncora que o leitor guarda como posição). */
export async function primeiroBlocoQueComeca(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.reader-viewport')!;
    const columns = document.querySelector<HTMLElement>('.reader-columns')!;
    const cs = getComputedStyle(viewport);
    const vr = viewport.getBoundingClientRect();
    const left = vr.left + parseFloat(cs.paddingLeft);
    const right = vr.right - parseFloat(cs.paddingRight);
    for (const el of columns.querySelectorAll<HTMLElement>('[data-i]')) {
      const r = el.getBoundingClientRect();
      if (r.left >= left - 1 && r.left < right) return Number(el.dataset.i);
    }
    return -1;
  });
}
