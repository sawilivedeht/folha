import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  estado,
  abrirConfig,
  fecharConfig,
  mostrarHud,
  esconderHud,
  aguardarAssentar,
  esperarLeitor,
  primeiroBlocoVisivel,
} from './helpers';
import type { Page } from '@playwright/test';

async function abrir(page: Page, arq = 'epub3.epub', titulo = 'Livro EPUB Três'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, [arq]);
  await abrirLivro(page, titulo);
}

test.describe('Configurações', () => {
  test('persistem após recarregar', async ({ page }) => {
    await abrir(page);
    await abrirConfig(page);
    const sheet = page.locator('.reader-aa-sheet');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'aumentar fonte' }).click();
    await page.getByRole('button', { name: 'Aumentar entrelinha' }).click();
    await page.getByRole('button', { name: 'Diminuir margem' }).click();
    await sheet.getByRole('button', { name: 'Sem serifa' }).or(sheet.locator('.reader-seg-btn--sans')).first().click();
    await sheet.locator('.reader-toggle-btn').first().click(); // justificar
    await sheet.locator('.reader-theme-btn--sepia').click();
    const antes = await page.evaluate(() => {
      const r = document.querySelector<HTMLElement>('.reader')!;
      const g = (n: string) => r.style.getPropertyValue(n);
      return { fs: g('--reader-font-size'), lh: g('--reader-line-height'), m: g('--reader-margin'), ff: g('--reader-font-family'), al: g('--reader-align'), tema: document.documentElement.dataset.theme };
    });
    expect(antes.fs).toBe('22px');
    expect(antes.tema).toBe('sepia');
    expect(antes.al).toBe('left');
    await page.waitForTimeout(300);
    await page.reload();
    await esperarLeitor(page);
    const depois = await page.evaluate(() => {
      const r = document.querySelector<HTMLElement>('.reader')!;
      const g = (n: string) => r.style.getPropertyValue(n);
      return { fs: g('--reader-font-size'), lh: g('--reader-line-height'), m: g('--reader-margin'), ff: g('--reader-font-family'), al: g('--reader-align'), tema: document.documentElement.dataset.theme };
    });
    expect(depois).toEqual(antes);
  });

  test('os quatro temas mudam data-theme e as cores', async ({ page }) => {
    await abrir(page);
    await abrirConfig(page);
    const cores = new Set<string>();
    for (const tema of ['light', 'sepia', 'dark', 'black']) {
      await page.locator(`.reader-theme-btn--${tema}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', tema);
      const c = await page.evaluate(() => {
        const r = document.querySelector('.reader')!;
        const cs = getComputedStyle(r);
        return `${cs.backgroundColor}|${cs.color}`;
      });
      expect(cores.has(c), `cores do tema ${tema} devem ser únicas`).toBe(false);
      cores.add(c);
    }
    expect(cores.size).toBe(4);
    // Escuros têm fundo escuro de verdade.
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.reader')!).backgroundColor);
    expect(bg).toBe('rgb(0, 0, 0)');
    await fecharConfig(page);
  });
});

test.describe('Marcadores, sumário e progresso', () => {
  test('marcador aparece no painel, navega e pode ser removido', async ({ page }) => {
    await abrir(page, 'longo.txt', 'O Grande Livro de Teste');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    const blocoMarcado = await primeiroBlocoVisivel(page);
    const paginaMarcada = (await estado(page)).pagina;
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toHaveAttribute('aria-pressed', 'true');
    await esconderHud(page);

    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    expect((await estado(page)).pagina).toBe(paginaMarcada + 8);

    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.getByRole('tab', { name: /Marcadores/ }).click();
    await expect(page.locator('.reader-bm-item')).toHaveCount(1);
    await page.locator('.reader-bm-main').click();
    await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
    await aguardarAssentar(page);
    expect((await estado(page)).pagina).toBe(paginaMarcada);
    expect(await primeiroBlocoVisivel(page)).toBe(blocoMarcado);

    // Remover pelo painel.
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.getByRole('tab', { name: /Marcadores/ }).click();
    await page.getByRole('button', { name: 'Remover marcador', exact: true }).click();
    await expect(page.locator('.reader-bm-item')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fechar sumário' }).click();
    await expect(page.getByRole('button', { name: 'Marcar esta página' })).toHaveAttribute('aria-pressed', 'false');

    // Marcar e desmarcar pelo botão da barra; persistência no IndexedDB.
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await page.waitForTimeout(100);
    await page.reload();
    await esperarLeitor(page);
    await mostrarHud(page);
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toBeVisible();
    await page.getByRole('button', { name: 'Remover marcador desta página' }).click();
    await expect(page.getByRole('button', { name: 'Marcar esta página' })).toBeVisible();
  });

  test('sumário navega para o capítulo', async ({ page }) => {
    await abrir(page);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    const itens = page.locator('.reader-toc-item');
    await expect(itens).toHaveCount(3);
    await itens.nth(2).click();
    await aguardarAssentar(page);
    await expect(page.locator('.reader-columns')).toContainText('Terceiro capítulo');
    expect((await estado(page)).pagina).toBe(1);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await expect(page.locator('.reader-toc-item.is-current')).toContainText('Terceiro capítulo');
  });

  test('controle deslizante de progresso navega e o percentual só aumenta ao avançar', async ({ page }) => {
    await abrir(page, 'longo.txt', 'O Grande Livro de Teste');
    await mostrarHud(page);
    const slider = page.getByRole('slider', { name: 'Progresso do livro' });
    await slider.fill('500');
    await aguardarAssentar(page);
    const meio = await estado(page);
    expect(meio.percentual).toBeGreaterThanOrEqual(40);
    expect(meio.percentual).toBeLessThanOrEqual(60);
    await slider.fill('0');
    await aguardarAssentar(page);
    expect((await estado(page)).percentual).toBe(0);
    await slider.fill('1000');
    await aguardarAssentar(page);
    expect((await estado(page)).percentual).toBe(100);

    await slider.fill('0');
    await aguardarAssentar(page);
    await slider.evaluate((el) => (el as HTMLElement).blur()); // o teclado só vira página fora de campos
    await esconderHud(page);
    let ultimo = -1;
    for (let i = 0; i < 400; i++) {
      const { percentual } = await estado(page);
      expect(percentual, `percentual na viragem ${i}`).toBeGreaterThanOrEqual(ultimo);
      ultimo = percentual;
      await page.keyboard.press('PageDown');
    }
    expect(ultimo).toBeGreaterThan(0);
  });
});
