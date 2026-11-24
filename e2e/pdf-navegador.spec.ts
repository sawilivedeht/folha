// Fluxo E2E no navegador real para PDFs de apresentação (slides) e PDFs de texto com figura grande:
// exercita pdf.js + canvas/OffscreenCanvas -> IndexedDB -> capa na estante -> leitor em 14px e 34px.
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  esperarCapaValida,
  esperarLeitor,
  definirFonte,
  mostrarHud,
  esconderHud,
  estado,
  verificarPaginaAtual,
  varrerCapituloInteiro,
} from './helpers';

async function irParaCapitulo(page: Page, indice: number, textoEsperado?: string): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item').nth(indice).click();
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  if (textoEsperado) {
    await expect(page.locator('.reader-columns')).toContainText(textoEsperado);
  }
  await esperarLeitor(page);
}

async function percorrerCapitulo(page: Page, rotulo: string): Promise<{ paginas: number; imagens: number }> {
  const { total } = await estado(page);
  expect(total, `${rotulo}: total de páginas`).toBeGreaterThan(0);
  let imagens = 0;
  for (let i = 0; i < total; i++) {
    const e = await estado(page);
    expect(e.pagina, `${rotulo}: página atual`).toBe(i + 1);
    const r = await verificarPaginaAtual(page);
    expect(r.violacoes, `${rotulo} pág ${i + 1}/${total}`).toEqual([]);
    imagens += r.imagens;
    if (i < total - 1) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await estado(page)).pagina).toBe(i + 2);
    }
  }
  return { paginas: total, imagens };
}

test.describe('PDF no navegador (slides e figura grande)', () => {
  test('PDF de slides: capa na estante, 2 capítulos (10 + 2) e imagem + texto em 14px e 34px', async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);
    await importarEFechar(page, ['slides.pdf']);

    const card = page.locator('.lib-card', { hasText: 'Apresentação de Slides' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Palestrante Exemplo');
    await esperarCapaValida(page, 'Apresentação de Slides');

    await abrirLivro(page, 'Apresentação de Slides');

    // Sumário deve agrupar 12 slides em 2 capítulos (10 + 2).
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    const itens = page.locator('.reader-toc-item');
    await expect(itens).toHaveCount(2);
    await expect(itens.nth(0)).toContainText('Slide 1');
    await expect(itens.nth(1)).toContainText('Slide 11');
    await page.getByRole('button', { name: 'Fechar sumário' }).click();
    await esconderHud(page);

    const conferirSlidesDoCapitulo = async (inicio: number, quantidade: number, rotulo: string): Promise<void> => {
      const encontrados = await page.evaluate(() => {
        const blocos = Array.from(document.querySelectorAll<HTMLElement>('.reader-columns [data-i]'));
        const saida: Array<{ alt: string; src: string; naturalWidth: number; textoSeguinte: string }> = [];
        for (let i = 0; i < blocos.length; i++) {
          const img = blocos[i].querySelector<HTMLImageElement>('img');
          if (!img) continue;
          const textoSeguinte = blocos
            .slice(i + 1, i + 5)
            .map((b) => b.textContent ?? '')
            .join(' ');
          saida.push({
            alt: img.alt,
            src: img.getAttribute('src') ?? '',
            naturalWidth: img.complete ? img.naturalWidth : 0,
            textoSeguinte,
          });
        }
        return saida;
      });
      expect(encontrados, `${rotulo}: quantidade de imagens de slide`).toHaveLength(quantidade);
      for (let i = 0; i < quantidade; i++) {
        const num = inicio + i;
        expect(encontrados[i].alt, `${rotulo}: alt do slide ${num}`).toBe(`Slide ${num}`);
        expect(encontrados[i].src, `${rotulo}: src blob do slide ${num}`).toMatch(/^blob:/);
        expect(encontrados[i].naturalWidth, `${rotulo}: naturalWidth do slide ${num}`).toBeGreaterThan(0);
        expect(encontrados[i].textoSeguinte, `${rotulo}: texto após imagem do slide ${num}`).toContain(`Slide ${num}:`);
        expect(encontrados[i].textoSeguinte, `${rotulo}: conteúdo do slide ${num}`).toContain(
          `Primeiro tópico explicando o slide número ${num}`,
        );
      }
    };

    for (const fonte of [14, 34]) {
      await definirFonte(page, fonte);

      await irParaCapitulo(page, 0, 'Slide 1:');
      const v1 = await varrerCapituloInteiro(page);
      expect(v1.violacoes, `slides cap 1 em ${fonte}px`).toEqual([]);
      await conferirSlidesDoCapitulo(1, 10, `cap 1 (${fonte}px)`);
      const p1 = await verificarPaginaAtual(page);
      expect(p1.violacoes, `slides cap 1 pág 1 em ${fonte}px`).toEqual([]);

      await irParaCapitulo(page, 1, 'Slide 11:');
      const v2 = await varrerCapituloInteiro(page);
      expect(v2.violacoes, `slides cap 2 em ${fonte}px`).toEqual([]);
      await conferirSlidesDoCapitulo(11, 2, `cap 2 (${fonte}px)`);
      const resCap2 = await percorrerCapitulo(page, `slides cap 2 (${fonte}px)`);
      expect(resCap2.imagens, `imagens válidas percorridas no cap 2 em ${fonte}px`).toBe(2);
    }
  });

  test('PDF de texto com figura grande: capa na estante, figura da pág. 2 com naturalWidth > 0 e texto sem cortes em 14px e 34px', async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);
    await importarEFechar(page, ['ilustrado.pdf']);

    const card = page.locator('.lib-card', { hasText: 'PDF Ilustrado' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Autora Visual');
    await esperarCapaValida(page, 'PDF Ilustrado');

    await abrirLivro(page, 'PDF Ilustrado');

    // Todo o texto antes, ao redor e depois da figura grande deve estar preservado.
    const colunas = page.locator('.reader-columns');
    await expect(colunas).toContainText('Texto inicial antes da página ilustrada');
    await expect(colunas).toContainText('Parágrafo anterior à figura grande na segunda página.');
    await expect(colunas).toContainText('Parágrafo posterior à figura grande na segunda página.');
    await expect(colunas).toContainText('Texto contínuo na terceira página após a ilustração');

    // A página 2 (cobertura de imagem > 50%) deve ter gerado um bloco <img> válido.
    const figura = colunas.locator('img[alt="Página 2"]');
    await expect(figura).toHaveCount(1);
    await expect(figura).toHaveAttribute('src', /^blob:/);
    const natW = await figura.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0));
    expect(natW, 'figura da página 2 carregada com naturalWidth > 0').toBeGreaterThan(0);

    for (const fonte of [14, 34]) {
      await definirFonte(page, fonte);
      await irParaCapitulo(page, 0);
      const v = await varrerCapituloInteiro(page);
      expect(v.violacoes, `ilustrado em ${fonte}px (varredura)`).toEqual([]);
      const res = await percorrerCapitulo(page, `ilustrado (${fonte}px)`);
      expect(res.paginas, `páginas percorridas em ${fonte}px`).toBeGreaterThan(0);
      expect(res.imagens, `figura da pág. 2 vista ao percorrer em ${fonte}px`).toBeGreaterThanOrEqual(1);
    }
  });
});
