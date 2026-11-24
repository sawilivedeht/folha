import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  arquivo,
  lerIndexedDB,
  mostrarHud,
  esperarLeitor,
} from './helpers';
import type { Page } from '@playwright/test';

async function importarMinis(page: Page, n = 10): Promise<void> {
  const arqs = [];
  for (let i = 1; i <= n; i++) arqs.push(arquivo(`mini-${i}.txt`));
  await importarEFechar(page, arqs);
}

const titulosNaGrade = (page: Page) => page.locator('.lib-grid .lib-card-title').allTextContents();

test.describe('Biblioteca', () => {
  test('ordenação por título, autor e mais recentes', async ({ page }) => {
    await abrirEstante(page);
    await importarMinis(page, 4);
    await importarEFechar(page, ['epub3.epub', 'epub2.epub']);
    const ordenar = page.getByLabel('Ordenar livros');

    await ordenar.selectOption('title');
    const porTitulo = await titulosNaGrade(page);
    const esperado = [...porTitulo].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    expect(porTitulo).toEqual(esperado);
    expect(porTitulo[0]).toBe('Livro A1');

    await ordenar.selectOption('author');
    const cards = await page.locator('.lib-grid .lib-card').all();
    const autores: string[] = [];
    for (const c of cards) autores.push((await c.locator('.lib-card-author').count()) ? ((await c.locator('.lib-card-author').textContent()) ?? '') : '');
    const autoresOrd = [...autores].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    expect(autores).toEqual(autoresOrd);
    expect(autores.slice(-2)).toEqual(['Autora Exemplar', 'Zeca Antigo']);

    await ordenar.selectOption('recent');
    const recentes = await titulosNaGrade(page);
    expect(recentes[0]).toBe('Livro EPUB Dois'); // o último importado vem primeiro
  });

  test('busca aparece só com mais de 8 livros e filtra por título e autor', async ({ page }) => {
    await abrirEstante(page);
    await importarMinis(page, 8);
    await expect(page.getByLabel('Buscar livros por título ou autor')).toHaveCount(0);
    await importarEFechar(page, ['mini-9.txt', 'mini-10.txt', 'epub3.epub']);
    const busca = page.getByLabel('Buscar livros por título ou autor');
    await expect(busca).toBeVisible();
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(11);
    await busca.fill('livro c');
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(1);
    await expect(page.locator('.lib-card-title')).toHaveText('Livro C3');
    await busca.fill('exemplar'); // autor
    await expect(page.locator('.lib-card-title')).toHaveText('Livro EPUB Três');
    await busca.fill('zzzz');
    await expect(page.locator('.lib-no-results')).toBeVisible();
    await busca.fill('');
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(11);
  });

  test('excluir pede confirmação e remove livro, conteúdo, capa e imagens do IndexedDB', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub', 'epub2.epub']);
    const metas = await lerIndexedDB<string[]>(page, 'meta');
    expect(metas).toHaveLength(2);
    const blobsAntes = await lerIndexedDB<string[]>(page, 'blobs');
    const alvo = page.locator('.lib-card', { hasText: 'Livro EPUB Três' });
    const idAlvo = (await Promise.all(metas.map(async (id) => [id, await lerIndexedDB<{ title: string }>(page, 'meta', id)] as const))).find(([, m]) => m.title === 'Livro EPUB Três')![0];
    expect(blobsAntes.filter((k) => k.startsWith(`${idAlvo}/`)).length).toBeGreaterThanOrEqual(2); // capa + imagem

    // Cancelar mantém o livro.
    await alvo.getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    await expect(page.locator('.lib-modal-text')).toContainText('Livro EPUB Três');
    await page.locator('.lib-modal').getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator('.lib-card')).toHaveCount(2);

    // Confirmar remove.
    await alvo.getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    await page.locator('.lib-modal .lib-btn-danger').click();
    await expect(page.locator('.lib-card')).toHaveCount(1);
    await expect(alvo).toHaveCount(0);
    expect(await lerIndexedDB<string[]>(page, 'meta')).not.toContain(idAlvo);
    expect(await lerIndexedDB(page, 'content', idAlvo)).toBeUndefined();
    const blobsDepois = await lerIndexedDB<string[]>(page, 'blobs');
    expect(blobsDepois.filter((k) => k.startsWith(`${idAlvo}/`))).toEqual([]);
    expect(blobsDepois.length).toBeLessThan(blobsAntes.length);
  });

  test('excluir por toque longo abre o menu do livro', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    const card = page.locator('.lib-card').first();
    const box = (await card.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const p = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await expect(page.locator('.reader')).toHaveCount(0); // não abriu o livro
  });

  test('"Continuar lendo" mostra o último aberto e o retorno funciona (botão e history.back)', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub', 'epub3.epub']);
    await expect(page.locator('.lib-continue-card')).toHaveCount(0);

    await abrirLivro(page, 'Livro EPUB Dois');
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();
    await expect(page.locator('.lib-continue-card')).toContainText('Livro EPUB Dois');

    await abrirLivro(page, 'Livro EPUB Três');
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();
    await expect(page.locator('.lib-continue-card')).toContainText('Livro EPUB Três');

    // Retomar pelo cartão "Continuar lendo" e voltar com history.back().
    await page.locator('.lib-continue-card').click();
    await esperarLeitor(page);
    await page.evaluate(() => history.back());
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });

  test('livro aberto por link direto que não existe mostra mensagem e volta', async ({ page }) => {
    await page.goto('/#/ler/nao-existe');
    await expect(page.getByRole('heading', { name: 'Livro não encontrado' })).toBeVisible();
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();
  });
});
