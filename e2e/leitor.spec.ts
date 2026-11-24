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
  lerIndexedDB,
} from './helpers';
import type { Page } from '@playwright/test';

interface EstiloComputadoLeitor {
  fontSize: number;
  lineHeightRatio: number;
  marginPx: number;
  fontFamily: string;
  textAlign: string;
  hyphens: string;
  tema: string | undefined;
  bg: string;
}

interface ConfigSalva {
  fontSize: number;
  lineHeight: number;
  margin: number;
  font: string;
  justify: boolean;
  hyphenate: boolean;
  theme: string;
}

async function lerEstilosComputados(page: Page): Promise<EstiloComputadoLeitor> {
  return page.evaluate(() => {
    const reader = document.querySelector<HTMLElement>('.reader')!;
    const viewport = document.querySelector<HTMLElement>('.reader-viewport')!;
    const p = document.querySelector<HTMLElement>('.reader-columns p')!;
    const rCs = getComputedStyle(reader);
    const vCs = getComputedStyle(viewport);
    const pCs = getComputedStyle(p);
    const fontSize = parseFloat(pCs.fontSize);
    const lineHeight = parseFloat(pCs.lineHeight);
    return {
      fontSize,
      lineHeightRatio: Number((lineHeight / fontSize).toFixed(2)),
      marginPx: parseFloat(vCs.paddingLeft),
      fontFamily: pCs.fontFamily,
      textAlign: pCs.textAlign,
      hyphens: pCs.hyphens,
      tema: document.documentElement.dataset.theme,
      bg: rCs.backgroundColor,
    };
  });
}

async function abrir(page: Page, arq = 'epub3.epub', titulo = 'Livro EPUB Três'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, [arq]);
  await abrirLivro(page, titulo);
}

test.describe('Configurações', () => {
  test('persistem após recarregar', async ({ page }) => {
    await abrir(page);
    const inicial = await lerEstilosComputados(page);

    await abrirConfig(page);
    const sheet = page.locator('.reader-aa-sheet');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'aumentar fonte' }).click();
    await page.getByRole('button', { name: 'Aumentar entrelinha' }).click();
    await page.getByRole('button', { name: 'Diminuir margem' }).click();
    await sheet.getByRole('button', { name: 'Sem serifa' }).or(sheet.locator('.reader-seg-btn--sans')).first().click();
    const toggles = sheet.locator('.reader-toggle-btn');
    await expect(toggles).toHaveCount(2);
    await toggles.nth(0).click(); // justificar
    await toggles.nth(1).click(); // hifenizar
    await sheet.locator('.reader-theme-btn--sepia').click();

    const antes = await lerEstilosComputados(page);
    expect(antes.fontSize, 'fonte aumentou para 22px').toBe(22);
    expect(antes.fontSize).toBeGreaterThan(inicial.fontSize);
    expect(antes.lineHeightRatio, 'entrelinha aumentou').toBeGreaterThan(inicial.lineHeightRatio);
    expect(antes.marginPx, 'margem diminuiu').toBeLessThan(inicial.marginPx);
    expect(antes.fontFamily, 'família da fonte mudou').not.toBe(inicial.fontFamily);
    expect(antes.textAlign, 'alinhamento mudou para esquerda').toBe('left');
    expect(antes.textAlign).not.toBe(inicial.textAlign);
    expect(antes.hyphens, 'hifenização mudou').not.toBe(inicial.hyphens);
    expect(['auto', 'none']).toContain(antes.hyphens);
    expect(antes.tema, 'tema mudou para sépia').toBe('sepia');
    expect(antes.bg, 'cor de fundo mudou').not.toBe(inicial.bg);

    await expect
      .poll(async () => lerIndexedDB<ConfigSalva | undefined>(page, 'kv', 'settings'))
      .toMatchObject({
        fontSize: 22,
        justify: false,
        hyphenate: antes.hyphens === 'auto',
        theme: 'sepia',
      });

    await page.reload();
    await esperarLeitor(page);
    const depois = await lerEstilosComputados(page);
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
    const [id] = await lerIndexedDB<string[]>(page, 'meta');
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => (await lerIndexedDB<{ bookmarks: unknown[] }>(page, 'meta', id)).bookmarks.length)
      .toBe(1);
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
    await esperarLeitor(page);
    const meio = await estado(page);
    expect(meio.percentual).toBeGreaterThanOrEqual(40);
    expect(meio.percentual).toBeLessThanOrEqual(60);
    await slider.fill('0');
    await esperarLeitor(page);
    expect((await estado(page)).percentual).toBe(0);
    await slider.fill('1000');
    await esperarLeitor(page);
    expect((await estado(page)).percentual).toBe(100);

    await slider.fill('0');
    await esperarLeitor(page);
    await slider.evaluate((el) => (el as HTMLElement).blur()); // o teclado só vira página fora de campos
    await esconderHud(page);
    let anterior = await estado(page);
    expect(anterior.pagina).toBe(1);
    expect(anterior.percentual).toBe(0);
    let viradas = 0;
    let trocasDeCapitulo = 0;
    const MAX_VIRADAS = 1500;
    while (!(anterior.pagina === anterior.total && anterior.percentual === 100)) {
      expect(viradas, 'chegou ao fim do livro dentro do limite de viradas').toBeLessThan(MAX_VIRADAS);
      await page.keyboard.press('PageDown');
      const atual = await estado(page);
      expect(atual.percentual, `percentual na virada ${viradas + 1}`).toBeGreaterThanOrEqual(anterior.percentual);
      if (anterior.pagina < anterior.total) {
        expect(atual.pagina, `página avançou na virada ${viradas + 1}`).toBe(anterior.pagina + 1);
      } else {
        expect(atual.pagina, `entrou no próximo capítulo na virada ${viradas + 1}`).toBe(1);
        trocasDeCapitulo++;
      }
      anterior = atual;
      viradas++;
    }
    expect(anterior.percentual).toBe(100);
    expect(trocasDeCapitulo).toBeGreaterThanOrEqual(3);
  });
});
