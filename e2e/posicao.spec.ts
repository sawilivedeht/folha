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
  lerIndexedDB,
} from './helpers';
import type { Page } from '@playwright/test';

interface MetaPosicao {
  position: { chapter: number; block: number };
  percent: number;
}

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
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  await esperarLeitor(page);
  const { total } = await estado(page);
  const passos = Math.min(25, Math.max(1, total - 2));
  for (let i = 0; i < passos; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await estado(page)).pagina).toBe(passos + 1);
}

/** Calcula o mesmo bloco âncora que o leitor grava (primeiro que começa na página ou o que a atravessa). */
async function blocoAncora(page: Page): Promise<number> {
  const inicio = await primeiroBlocoQueComeca(page);
  return inicio >= 0 ? inicio : await primeiroBlocoVisivel(page);
}

test.describe('Posição', () => {
  test('recarregar e reabrir o livro volta ao mesmo primeiro bloco', async ({ page }) => {
    await abrirLongo(page);
    await irParaMeio(page);
    const antes = await estado(page);
    const bloco = await primeiroBlocoVisivel(page);
    const ancora = await blocoAncora(page);
    const [id] = await lerIndexedDB<string[]>(page, 'meta');
    await expect
      .poll(async () => (await lerIndexedDB<MetaPosicao>(page, 'meta', id)).position)
      .toEqual({ chapter: 1, block: ancora });

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
    const [id] = await lerIndexedDB<string[]>(page, 'meta');
    const blocoAntes = await blocoAncora(page);
    // Garante que a posição inicial já foi gravada no IndexedDB antes da virada testada.
    await expect
      .poll(async () => (await lerIndexedDB<MetaPosicao>(page, 'meta', id)).position)
      .toEqual({ chapter: 1, block: blocoAntes });

    const paginaAntes = (await estado(page)).pagina;
    // Vira ao menos uma página (se um parágrafo longo ocupar toda a página, avança até mudar o bloco âncora).
    let blocoDepois = -1;
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      const cand = await primeiroBlocoQueComeca(page);
      if (cand > blocoAntes) {
        blocoDepois = cand;
        break;
      }
    }
    expect(blocoDepois, 'bloco âncora avançou após virar a página').toBeGreaterThan(blocoAntes);
    const paginaDepois = (await estado(page)).pagina;
    expect(paginaDepois).toBeGreaterThan(paginaAntes);

    // Confirma que o debounce de 800 ms ainda não gravou a nova posição no IndexedDB.
    const metaAntesDoReload = await lerIndexedDB<MetaPosicao>(page, 'meta', id);
    expect(metaAntesDoReload.position.block, 'debounce ainda não deve ter gravado no IndexedDB').toBe(blocoAntes);

    await page.reload(); // sem esperar o debounce
    await esperarLeitor(page);
    expect((await estado(page)).pagina).toBe(paginaDepois);
    expect(await primeiroBlocoQueComeca(page)).toBe(blocoDepois);
  });

  test('A+ / A− e girar a tela mantêm o primeiro bloco visível', async ({ page }) => {
    await abrirLongo(page);
    await irParaMeio(page);
    const bloco = await primeiroBlocoQueComeca(page);
    expect(bloco).toBeGreaterThanOrEqual(0);

    for (const fonte of [26, 34, 14, 19]) {
      await definirFonte(page, fonte);
      expect(await blocoVisivel(page, bloco), `bloco ${bloco} visível com fonte ${fonte}`).toBe(true);
      const inicio = await primeiroBlocoQueComeca(page);
      expect(inicio, `há bloco começando na página com fonte ${fonte}`).toBeGreaterThanOrEqual(0);
      expect(inicio, `página começa no bloco âncora (ou antes dele) com fonte ${fonte}`).toBeLessThanOrEqual(bloco);
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
