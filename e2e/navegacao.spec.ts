import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  estado,
  tocar,
  deslizar,
  mostrarHud,
  esconderHud,
} from './helpers';
import type { Page } from '@playwright/test';

async function abrirEpub2(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, ['epub2.epub']);
  await abrirLivro(page, 'Livro EPUB Dois');
}

async function abrirLongoCapitulo1(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, ['longo.txt']);
  await abrirLivro(page, 'O Grande Livro de Teste');
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item', { hasText: 'Capítulo 1' }).click();
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 300)));
}

async function capituloAtual(page: Page): Promise<string> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  const t = (await page.locator('.reader-toc-item.is-current').textContent())?.trim() ?? '';
  await page.getByRole('button', { name: 'Fechar sumário' }).click();
  await esconderHud(page);
  return t;
}

async function irParaUltimaPagina(page: Page): Promise<void> {
  const { total } = await estado(page);
  for (let i = 1; i < total; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await estado(page)).pagina).toBe(total);
}

test.describe('Navegação', () => {
  test('toque nos terços e no centro', async ({ page }) => {
    await abrirLongoCapitulo1(page);
    expect((await estado(page)).pagina).toBe(1);
    await tocar(page, 0.9);
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    await tocar(page, 0.1);
    await expect.poll(async () => (await estado(page)).pagina).toBe(1);
    await tocar(page, 0.5);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
    await tocar(page, 0.5);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
    // O toque na lateral com as barras abertas só as fecha e vira a página.
    await tocar(page, 0.5);
    await tocar(page, 0.9);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
  });

  test('deslizar para os lados vira a página', async ({ page }) => {
    await abrirLongoCapitulo1(page);
    await deslizar(page, 'esquerda');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    await deslizar(page, 'esquerda');
    await expect.poll(async () => (await estado(page)).pagina).toBe(3);
    await deslizar(page, 'direita');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
  });

  test('teclado: setas, PageDown/PageUp e espaço', async ({ page }) => {
    await abrirLongoCapitulo1(page);
    const pag = async () => (await estado(page)).pagina;
    await page.keyboard.press('ArrowRight');
    expect(await pag()).toBe(2);
    await page.keyboard.press('PageDown');
    expect(await pag()).toBe(3);
    await page.keyboard.press('Space');
    expect(await pag()).toBe(4);
    await page.keyboard.press('ArrowLeft');
    expect(await pag()).toBe(3);
    await page.keyboard.press('PageUp');
    expect(await pag()).toBe(2);
    await page.keyboard.press('Shift+Space');
    expect(await pag()).toBe(1);
    await page.keyboard.press('ArrowLeft'); // início do livro: não sai da primeira página
    expect(await pag()).toBe(1);
  });

  test('limites de capítulo: última → próximo capítulo página 1; primeira → anterior na última', async ({ page }) => {
    await abrirEpub2(page);
    expect(await capituloAtual(page)).toBe('Parte Alfa');
    const totalAlfa = (await estado(page)).total;
    await irParaUltimaPagina(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => capituloAtual(page)).toBe('Parte Beta');
    expect((await estado(page)).pagina).toBe(1);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => capituloAtual(page)).toBe('Parte Alfa');
    const e = await estado(page);
    expect(e.pagina).toBe(totalAlfa);
    expect(e.total).toBe(totalAlfa);
  });

  test('fim do livro: avançar na última página não muda de página', async ({ page }) => {
    await abrirEpub2(page);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.locator('.reader-toc-item').nth(1).click();
    await irParaUltimaPagina(page);
    const antes = await estado(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageDown');
    const depois = await estado(page);
    expect(depois.pagina).toBe(antes.pagina);
    expect(depois.percentual).toBe(100);
  });
});
