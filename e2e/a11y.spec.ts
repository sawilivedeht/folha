import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, abrirEstante, importarEFechar, abrirLivro, abrirConfig } from './helpers';

const TEMAS = ['light', 'sepia', 'dark', 'black'] as const;
type Tema = (typeof TEMAS)[number];
const ROTULO_TEMA: Record<Tema, string> = {
  light: 'Claro',
  sepia: 'Sépia',
  dark: 'Escuro',
  black: 'Preto',
};

async function violacoesGraves(page: Page, escopo?: string): Promise<string[]> {
  // Aguarda o fim de transições finitas e um par de quadros para o axe ler as cores finais sem tempo fixo.
  await page.evaluate(async () => {
    const anims = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (escopo) b = b.include(escopo);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' ' + (n.any[0]?.message ?? '')).join(' | ')}`);
}

async function escolherTemaNaEstante(page: Page, tema: Tema): Promise<void> {
  const btn = page.getByRole('button', { name: /alternar tema/i });
  await expect(btn).toHaveAttribute('aria-label', /^Tema /);
  for (let i = 0; i < TEMAS.length; i++) {
    const texto = (await btn.textContent())?.trim();
    if (texto === ROTULO_TEMA[tema]) break;
    await btn.click();
    await expect(btn).not.toHaveText(texto ?? '');
  }
  await expect(btn).toHaveText(ROTULO_TEMA[tema]);
  if (tema !== 'light') {
    await expect(page.locator('html')).toHaveAttribute('data-theme', tema);
  }
}

test.describe('Acessibilidade (axe-core)', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('estante vazia', async ({ page }) => {
    await abrirEstante(page);
    expect(await violacoesGraves(page), 'estante vazia').toEqual([]);
  });

  for (const tema of TEMAS) {
    test(`estante com livros, tema ${tema}`, async ({ page }) => {
      await abrirEstante(page);
      await importarEFechar(page, ['epub3.epub', 'epub2.epub', 'texto.pdf']);
      await escolherTemaNaEstante(page, tema);
      expect(await violacoesGraves(page), `estante, tema ${tema}`).toEqual([]);
    });
  }

  test('menus e diálogos da estante', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    await page.getByRole('button', { name: /Opções para/ }).first().click();
    expect(await violacoesGraves(page), 'menu do livro').toEqual([]);
    await page.getByRole('button', { name: 'Detalhes' }).click();
    expect(await violacoesGraves(page), 'detalhes').toEqual([]);
    await page.getByRole('button', { name: 'Fechar' }).click();
    await page.getByRole('button', { name: /Opções para/ }).first().click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    expect(await violacoesGraves(page), 'confirmação de exclusão').toEqual([]);
  });

  for (const tema of TEMAS) {
    test(`leitor com barras e painéis abertos, tema ${tema}`, async ({ page }) => {
      await abrirEstante(page);
      await importarEFechar(page, ['epub3.epub']);
      await abrirLivro(page, 'Livro EPUB Três');
      await abrirConfig(page);
      await page.locator(`.reader-theme-btn--${tema}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', tema);
      expect(await violacoesGraves(page), `Aa aberto (${tema})`).toEqual([]);
      await page.getByRole('button', { name: 'Fechar configurações' }).click();
      expect(await violacoesGraves(page), `barras abertas (${tema})`).toEqual([]);
      await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
      expect(await violacoesGraves(page), `sumário (${tema})`).toEqual([]);
      await page.getByRole('tab', { name: /Marcadores/ }).click();
      expect(await violacoesGraves(page), `marcadores vazio (${tema})`).toEqual([]);
      await page.getByRole('button', { name: 'Fechar sumário' }).click();
      await page.getByRole('button', { name: 'Marcar esta página' }).click();
      await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
      await page.getByRole('tab', { name: /Marcadores/ }).click();
      expect(await violacoesGraves(page), `marcadores (${tema})`).toEqual([]);
    });
  }

  for (const tema of TEMAS) {
    test(`leitor com texto na página (sem barras), tema ${tema}`, async ({ page }) => {
      await abrirEstante(page);
      await importarEFechar(page, ['epub3.epub']);
      await escolherTemaNaEstante(page, tema);
      await abrirLivro(page, 'Livro EPUB Três');
      await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
      expect(await violacoesGraves(page), `página de leitura (${tema})`).toEqual([]);
    });
  }
});
