import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  estado,
  definirFonte,
  primeiroBlocoVisivel,
  primeiroBlocoQueComeca,
  blocoVisivel,
  mostrarHud,
  aguardarAssentar,
  esperarLeitor,
} from './helpers';
import type { Page } from '@playwright/test';

async function abrirLongo(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, ['longo.txt']);
  await abrirLivro(page, 'O Grande Livro de Teste');
}

async function irParaMeio(page: Page): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item').nth(1).click();
  await aguardarAssentar(page);
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
  await aguardarAssentar(page);
}

test.describe('Posição', () => {
  test('recarregar e reabrir o livro volta ao mesmo primeiro bloco', async ({ page }) => {
    await abrirLongo(page);
    await irParaMeio(page);
    const antes = await estado(page);
    const bloco = await primeiroBlocoVisivel(page);
    await page.waitForTimeout(1200); // espera o salvamento (debounce de 800 ms)

    await page.reload();
    await esperarLeitor(page);
    expect(await primeiroBlocoVisivel(page)).toBe(bloco);
    expect((await estado(page)).pagina).toBe(antes.pagina);

    // Voltar à estante e reabrir.
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();
    await abrirLivro(page, 'O Grande Livro de Teste');
    expect(await primeiroBlocoVisivel(page)).toBe(bloco);
    expect((await estado(page)).percentual).toBe(antes.percentual);
  });

  test('recarregar logo após virar a página não perde a posição', async ({ page }) => {
    await abrirLongo(page);
    await irParaMeio(page);
    const bloco = await primeiroBlocoVisivel(page);
    await page.reload(); // sem esperar o debounce
    await esperarLeitor(page);
    expect(await primeiroBlocoVisivel(page)).toBe(bloco);
  });

  test('A+ / A− e girar a tela mantêm o primeiro bloco visível', async ({ page }) => {
    await abrirLongo(page);
    await irParaMeio(page);
    const bloco = await primeiroBlocoQueComeca(page);
    expect(bloco).toBeGreaterThanOrEqual(0);

    for (const fonte of [26, 34, 14, 19]) {
      await definirFonte(page, fonte);
      expect(await blocoVisivel(page, bloco), `bloco ${bloco} visível com fonte ${fonte}`).toBe(true);
      expect(await primeiroBlocoQueComeca(page), `página começa no bloco âncora (ou antes dele) com fonte ${fonte}`).toBeLessThanOrEqual(bloco);
    }

    const tam = page.viewportSize()!;
    await page.setViewportSize({ width: tam.height, height: tam.width });
    await aguardarAssentar(page);
    expect(await blocoVisivel(page, bloco), 'bloco visível na horizontal').toBe(true);
    await page.setViewportSize(tam);
    await aguardarAssentar(page);
    expect(await blocoVisivel(page, bloco), 'bloco visível ao voltar à vertical').toBe(true);
    // Depois de tudo, o total de páginas e o status continuam coerentes.
    const e = await estado(page);
    expect(e.pagina).toBeGreaterThan(0);
    expect(e.pagina).toBeLessThanOrEqual(e.total);
  });
});
