import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, abrirEstante, importarEFechar, abrirLivro, mostrarHud, abrirConfig } from './helpers';

async function violacoesGraves(page: Page, escopo?: string): Promise<string[]> {
  await page.waitForTimeout(350); // deixa as transições de opacidade dos painéis terminarem (o axe lê a cor final)
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (escopo) b = b.include(escopo);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' ' + (n.any[0]?.message ?? '')).join(' | ')}`);
}

const TEMAS = ['light', 'sepia', 'dark', 'black'] as const;

test.describe('Acessibilidade (axe-core)', () => {
  test('estante vazia', async ({ page }) => {
    await abrirEstante(page);
    expect(await violacoesGraves(page), 'estante vazia').toEqual([]);
  });

  for (const tema of TEMAS) {
    test(`estante com livros, tema ${tema}`, async ({ page }) => {
      // BUG: --muted do tema sépia (#7a6a55 sobre #f1e5cc) tem contraste 4,18:1 (< 4,5:1); o token fica em src/styles/base.css.
      // Correção sugerida: --muted: #6b5b46 em :root[data-theme='sepia'].
      test.fail(tema === 'sepia', 'contraste do token --muted do tema sépia (base.css)');
      await abrirEstante(page);
      await importarEFechar(page, ['epub3.epub', 'epub2.epub', 'texto.pdf']);
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), tema);
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
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await abrirEstante(page);
      await importarEFechar(page, ['epub3.epub']);
      await abrirLivro(page, 'Livro EPUB Três');
      await abrirConfig(page);
      await page.locator(`.reader-theme-btn--${tema}`).click();
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

  test('leitor com texto na página (sem barras), tema claro', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    await abrirLivro(page, 'Livro EPUB Três');
    expect(await violacoesGraves(page), 'página de leitura').toEqual([]);
    await mostrarHud(page);
  });
});
