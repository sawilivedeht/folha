import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  definirFonte,
  estado,
  verificarPaginaAtual,
  varrerCapituloInteiro,
  geometria,
  mostrarHud,
  esconderHud,
} from './helpers';
import type { Page } from '@playwright/test';

const LIVROS: Array<{ arquivo: string; titulo: string; fixo?: boolean; capituloCurto?: string }> = [
  { arquivo: 'longo.txt', titulo: 'O Grande Livro de Teste', capituloCurto: 'Capítulo 4' },
  { arquivo: 'gigante.txt', titulo: 'Texto com Palavras Gigantes' },
  { arquivo: 'epub3.epub', titulo: 'Livro EPUB Três' },
  { arquivo: 'epub2.epub', titulo: 'Livro EPUB Dois' },
  { arquivo: 'texto.pdf', titulo: 'PDF de Texto' },
  { arquivo: 'escaneado.pdf', titulo: 'PDF Escaneado', fixo: true },
];
const FONTES = [14, 19, 26, 34];

async function irParaCapitulo(page: Page, titulo: string | RegExp): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item', { hasText: titulo }).first().click();
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => r()), 250)));
}

async function proximaPagina(page: Page): Promise<void> {
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

test.describe('Tudo cabe na página', () => {
  for (const livro of LIVROS) {
    for (const fonte of FONTES) {
      test(`${livro.arquivo} em ${fonte}px`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await abrirEstante(page);
        await importarEFechar(page, [livro.arquivo]);
        await abrirLivro(page, livro.titulo);
        await definirFonte(page, fonte);

        const falhas: string[] = [];
        let imagensVistas = 0;
        let retangulosVistos = 0;
        let paginasVistas = 0;
        const registrar = (rot: string, v: string[]) => v.forEach((x) => falhas.push(`${rot}: ${x}`));

        let capitulos = 1;
        if (!livro.fixo) {
          await mostrarHud(page);
          await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
          capitulos = await page.locator('.reader-toc-item').count();
          await page.getByRole('button', { name: 'Fechar sumário' }).click();
          await esconderHud(page);
        }

        // Percorre capítulo a capítulo com navegação real, página a página (capítulos curtos)
        // ou só com varredura geométrica (capítulos longos do livro de 300 mil caracteres).
        const percorrerReal = async (rotulo: string, limite: number) => {
          const e0 = await estado(page);
          const total = e0.total;
          expect(total, `${rotulo}: total de páginas`).toBeGreaterThan(0);
          const g = await geometria(page);
          expect(g.total * g.step, `${rotulo}: páginas × passo ≥ scrollWidth`).toBeGreaterThanOrEqual(g.scrollW);
          const n = Math.min(total, limite);
          for (let i = 0; i < n; i++) {
            const e = await estado(page);
            if (e.pagina !== i + 1) {
              falhas.push(`${rotulo}: esperava página ${i + 1}, está na ${e.pagina}`);
              break;
            }
            const r = await verificarPaginaAtual(page);
            registrar(`${rotulo} pág ${i + 1}/${total}`, r.violacoes);
            imagensVistas += r.imagens;
            retangulosVistos += r.retangulos;
            paginasVistas++;
            if (livro.fixo && r.imagens !== 1) falhas.push(`${rotulo} pág ${i + 1}: esperava 1 imagem, achou ${r.imagens}`);
            if (r.blocosVisiveis === 0 && !livro.fixo) falhas.push(`${rotulo} pág ${i + 1}: nenhum bloco visível`);
            if (falhas.length) break;
            if (i < n - 1) await proximaPagina(page);
          }
        };

        const varrer = async (rotulo: string) => {
          const v = await varrerCapituloInteiro(page);
          registrar(`${rotulo} (varredura, ${v.paginas} págs)`, v.violacoes);
        };

        if (livro.fixo) {
          await percorrerReal(`${livro.arquivo}`, 50);
        } else if (livro.arquivo === 'longo.txt') {
          for (let c = 1; c <= 3; c++) {
            await irParaCapitulo(page, `Capítulo ${c}`);
            await varrer(`capítulo ${c}`);
            await percorrerReal(`capítulo ${c}`, 12); // amostra real das primeiras páginas
          }
          await irParaCapitulo(page, 'Capítulo 4');
          await varrer('capítulo 4');
          await percorrerReal('capítulo 4', 10_000); // TODAS as páginas
        } else {
          for (let c = 0; c < capitulos; c++) {
            await irParaCapituloIndice(page, c);
            await varrer(`capítulo ${c + 1}`);
            await percorrerReal(`capítulo ${c + 1}`, 10_000);
          }
        }

        expect(falhas, falhas.join('\n')).toEqual([]);
        expect(paginasVistas, 'páginas percorridas').toBeGreaterThan(0);
        expect(retangulosVistos, 'retângulos de texto/imagem verificados').toBeGreaterThanOrEqual(paginasVistas);
        if (livro.arquivo === 'epub3.epub') expect(imagensVistas, 'imagens verificadas').toBeGreaterThan(0);
        test.info().annotations.push({ type: 'páginas', description: `${paginasVistas} páginas, ${retangulosVistos} retângulos, ${imagensVistas} imagens` });
      });
    }
  }
});

async function irParaCapituloIndice(page: Page, indice: number): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item').nth(indice).click();
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => r()), 250)));
}
