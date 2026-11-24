// Gestos de toque reais em fronteiras de capítulo/livro, PDF fixedLayout e cancelamentos.
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  estado,
  tocar,
  deslizar,
  verificarPaginaAtual,
} from './helpers';

/** Dispara um arrasto por toque a partir do centro do viewport, deslocando (dx, dy) em pixels. */
async function arrastarNoLeitor(page: Page, dx: number, dy: number, passos = 6): Promise<void> {
  const r = await page.locator('.reader-viewport').boundingBox();
  if (!r) throw new Error('viewport ausente');
  const x0 = r.x + r.width * 0.5;
  const y0 = r.y + r.height * 0.5;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= passos; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x0 + (dx * i) / passos, y: y0 + (dy * i) / passos }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
}

async function imagemVisivelAtual(page: Page): Promise<{ alt: string; src: string; naturalWidth: number } | null> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.reader-viewport')!;
    const cs = getComputedStyle(viewport);
    const vr = viewport.getBoundingClientRect();
    const left = vr.left + parseFloat(cs.paddingLeft);
    const right = vr.right - parseFloat(cs.paddingRight);
    for (const img of document.querySelectorAll<HTMLImageElement>('.reader-columns img')) {
      const r = img.getBoundingClientRect();
      const cx = (r.left + r.right) / 2;
      if (r.width > 0 && cx >= left - 1 && cx <= right + 1) {
        return {
          alt: img.alt,
          src: img.getAttribute('src') ?? '',
          naturalWidth: img.complete ? img.naturalWidth : 0,
        };
      }
    }
    return null;
  });
}

async function irParaUltimaPaginaDoCapitulo(page: Page): Promise<number> {
  const { total } = await estado(page);
  for (let i = 1; i < total; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await estado(page)).pagina).toBe(total);
  return total;
}

test.describe('Gestos de toque', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('deslize atravessa capítulos e respeita os limites do livro', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    await abrirLivro(page, 'Livro EPUB Dois');

    // Limite inicial: deslizar para a direita na 1ª página do 1º capítulo mantém na pág. 1.
    await expect(page.locator('.reader-columns')).toContainText('Parte Alfa');
    expect((await estado(page)).pagina).toBe(1);
    await deslizar(page, 'direita');
    await expect(page.locator('.reader-columns')).toContainText('Parte Alfa');
    expect((await estado(page)).pagina).toBe(1);

    // Última página de Parte Alfa -> deslize para a esquerda entra em Parte Beta pág. 1.
    const totalAlfa = await irParaUltimaPaginaDoCapitulo(page);
    await deslizar(page, 'esquerda');
    await expect(page.locator('.reader-columns')).toContainText('Parte Beta');
    await expect.poll(async () => (await estado(page)).pagina).toBe(1);

    // Primeira página de Parte Beta -> deslize para a direita volta à última página de Parte Alfa.
    await deslizar(page, 'direita');
    await expect(page.locator('.reader-columns')).toContainText('Parte Alfa');
    await expect.poll(async () => (await estado(page)).pagina).toBe(totalAlfa);

    // Limite final: na última página de Parte Beta, deslizar para a esquerda não sai do fim do livro.
    await deslizar(page, 'esquerda');
    await expect(page.locator('.reader-columns')).toContainText('Parte Beta');
    const totalBeta = await irParaUltimaPaginaDoCapitulo(page);
    await deslizar(page, 'esquerda');
    await expect(page.locator('.reader-columns')).toContainText('Parte Beta');
    const fim = await estado(page);
    expect(fim.pagina).toBe(totalBeta);
    expect(fim.percentual).toBe(100);
  });

  test('PDF escaneado (fixedLayout): toque e deslize navegam pelas 3 páginas e respeitam limites', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['escaneado.pdf']);
    await abrirLivro(page, 'PDF Escaneado');

    expect(await estado(page)).toMatchObject({ pagina: 1, total: 3 });
    const img1 = await imagemVisivelAtual(page);
    expect(img1, 'página 1 visível').not.toBeNull();
    expect(img1!.alt).toBe('Página 1');
    expect(img1!.naturalWidth).toBeGreaterThan(0);

    // No início do livro, voltar por toque ou deslize mantém na página 1.
    await deslizar(page, 'direita');
    await tocar(page, 0.1);
    expect((await estado(page)).pagina).toBe(1);
    expect((await imagemVisivelAtual(page))?.alt).toBe('Página 1');

    // Avança para a página 2 via toque e para a página 3 via deslize.
    await tocar(page, 0.9);
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    const img2 = await imagemVisivelAtual(page);
    expect(img2?.alt).toBe('Página 2');
    expect(img2?.src).not.toBe(img1!.src);
    expect(img2?.naturalWidth).toBeGreaterThan(0);

    await deslizar(page, 'esquerda');
    await expect.poll(async () => (await estado(page)).pagina).toBe(3);
    const img3 = await imagemVisivelAtual(page);
    expect(img3?.alt).toBe('Página 3');
    expect(img3?.src).not.toBe(img2!.src);
    expect(img3?.naturalWidth).toBeGreaterThan(0);

    // No fim do livro, avançar por deslize ou toque mantém na página 3.
    await deslizar(page, 'esquerda');
    await tocar(page, 0.9);
    expect(await estado(page)).toMatchObject({ pagina: 3, total: 3, percentual: 100 });
    expect((await imagemVisivelAtual(page))?.alt).toBe('Página 3');

    // Recua por deslize para a página 2 e por toque para a página 1.
    await deslizar(page, 'direita');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    expect((await imagemVisivelAtual(page))?.alt).toBe('Página 2');

    await tocar(page, 0.1);
    await expect.poll(async () => (await estado(page)).pagina).toBe(1);
    expect((await imagemVisivelAtual(page))?.alt).toBe('Página 1');
  });

  test('deslize horizontal curto e arrasto vertical são ignorados no leitor', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    await abrirLivro(page, 'Livro EPUB Dois');

    // Fica na página 2 para que nenhum dos dois lados esteja bloqueado por limite do livro.
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);

    // Deslizes horizontais curtos (~15 px, abaixo do limiar de 40 px) não viram página nem abrem o HUD.
    await arrastarNoLeitor(page, -15, 0, 4);
    expect((await estado(page)).pagina).toBe(2);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
    expect((await verificarPaginaAtual(page)).violacoes).toEqual([]);

    await arrastarNoLeitor(page, 15, 0, 4);
    expect((await estado(page)).pagina).toBe(2);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
    expect((await verificarPaginaAtual(page)).violacoes).toEqual([]);

    // Arrastos verticais (~120 px) também são ignorados.
    await arrastarNoLeitor(page, 0, -120, 6);
    expect((await estado(page)).pagina).toBe(2);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);

    await arrastarNoLeitor(page, 0, 120, 6);
    expect((await estado(page)).pagina).toBe(2);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
  });

  test('toque longo na estante é cancelado por movimento do dedo (rolagem)', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);

    const card = page.locator('.lib-card').first();
    const box = (await card.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 4; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - i * 10 }],
      });
    }
    // Segura além dos 500 ms do toque longo para confirmar que o movimento cancelou o temporizador.
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();

    await expect(page.locator('.lib-modal')).toHaveCount(0);
    await expect(page.locator('.reader')).toHaveCount(0);
    await expect(page.locator('.lib-page')).toBeVisible();
  });
});
