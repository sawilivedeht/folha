import { describe, expect, it } from 'vitest';
import {
  buildBookPdf,
  buildEmptyPagesPdf,
  buildListAndStylesPdf,
  buildPasswordPdf,
  buildScannedPdf,
  buildSlidesPdf,
  buildTextWithFigurePdf,
  buildTwoColumnPdf,
  buildZeroPagesPdf,
} from '../../test/fixtures/pdf-fixtures';
import { allBlocks, allText, convertPdfBytes } from '../../test/fixtures/pdf-node';

const LOREM = [
  'A informação digital transformou profundamente a comunicação contemporânea, permitindo que pessoas em lugares distantes colaborem, aprendam e compartilhem experiências em tempo real.',
  'Aplicações móveis modernas dependem de arquitetura bem planejada, separação de responsabilidades e uma preocupação constante com desempenho, acessibilidade e consumo de energia do aparelho.',
  'Estudos recentes mostram que a leitura em telas pequenas exige tipografia cuidadosa, margens generosas e espaçamento consistente, para que a atenção do leitor permaneça no conteúdo e não na interface.',
  'A implementação correta de uma biblioteca digital considera formatos variados, codificação de caracteres, hifenização automática e a preservação da estrutura original dos capítulos.',
];

function makeBody(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) out.push(LOREM[i % LOREM.length]);
  return out;
}

describe('PDF de ponta a ponta (pdf-lib + pdf.js no Node)', () => {
  it('une palavras hifenizadas no fim da linha e mantém a ordem dos parágrafos', async () => {
    const bytes = await buildBookPdf({ paragraphs: makeBody(), hyphenate: true, textWidth: 250 });
    const r = await convertPdfBytes(bytes);
    expect(r.numPages).toBeGreaterThan(1);
    const text = allText(r.chapters);
    // Nenhum hífen de quebra de linha deve sobrar no meio de palavras.
    expect(text).not.toMatch(/\p{L}-\s+\p{L}/u);
    for (const p of LOREM) {
      expect(text.replace(/\s+/g, ' ')).toContain(p.slice(0, 60));
    }
    expect(text).toContain('informação');
    expect(text).toContain('hifenização');
    const first = text.indexOf('A informação digital');
    const last = text.lastIndexOf('A implementação correta');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
  });

  it('parágrafos viram blocos separados, não uma linha por bloco', async () => {
    const bytes = await buildBookPdf({ paragraphs: LOREM });
    const r = await convertPdfBytes(bytes);
    const paras = allBlocks(r.chapters).filter((b) => b.t === 'p');
    expect(paras).toHaveLength(LOREM.length);
  });

  it('remove cabeçalho repetido e número de página', async () => {
    const bytes = await buildBookPdf({
      paragraphs: [...makeBody(), ...makeBody(), ...makeBody()],
      header: 'Cabeçalho Repetido do Livro',
      footerPageNumbers: true,
    });
    const r = await convertPdfBytes(bytes);
    expect(r.numPages).toBeGreaterThan(2);
    const text = allText(r.chapters);
    expect(text).not.toContain('Cabeçalho Repetido');
    expect(text).not.toMatch(/^\d{1,2}$/m);
    expect(text).toContain('A informação digital');
  });

  it('detecta títulos pela fonte maior e divide em capítulos', async () => {
    const body = makeBody();
    const bytes = await buildBookPdf({
      paragraphs: body,
      headings: [
        { before: 0, text: 'Capítulo Um', size: 22 },
        { before: 6, text: 'Capítulo Dois', size: 22 },
      ],
    });
    const r = await convertPdfBytes(bytes);
    const titles = r.chapters.map((c) => c.title);
    expect(titles).toContain('Capítulo Um');
    expect(titles).toContain('Capítulo Dois');
    const two = r.chapters.find((c) => c.title === 'Capítulo Dois');
    expect(two?.blocks[0]).toMatchObject({ t: 'h', text: 'Capítulo Dois' });
    const um = r.chapters.find((c) => c.title === 'Capítulo Um');
    expect(um?.blocks.some((b) => b.t === 'h' && b.text === 'Capítulo Dois')).toBe(false);
  });

  it('lê duas colunas na ordem: esquerda inteira, depois a direita', async () => {
    const left = Array.from({ length: 24 }, (_, i) => `esquerda ${i + 1} texto corrido da primeira coluna aqui`);
    const right = Array.from({ length: 24 }, (_, i) => `direita ${i + 1} texto corrido da segunda coluna aqui`);
    const r = await convertPdfBytes(await buildTwoColumnPdf(left, right));
    const text = allText(r.chapters);
    expect(text).toContain('esquerda');
    expect(text).toContain('direita');
    expect(text.lastIndexOf('esquerda')).toBeLessThan(text.indexOf('direita'));
  });

  it('reconhece lista com marcadores e preserva negrito/itálico em runs', async () => {
    const r = await convertPdfBytes(await buildListAndStylesPdf());
    const blocks = allBlocks(r.chapters);
    const items = blocks.filter((b) => b.t === 'li');
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ text: expect.stringContaining('primeiro item') });
    const styled = blocks.find((b) => b.t === 'p' && b.text.includes('negrito'));
    expect(styled).toBeDefined();
    if (styled && styled.t === 'p') {
      expect(styled.runs?.some((run) => run.b === 1 && run.s.includes('negrito'))).toBe(true);
      expect(styled.runs?.some((run) => run.i === 1 && run.s.includes('itálico'))).toBe(true);
    }
  });

  it('página só com imagem não tem camada de texto (candidata a escaneada)', async () => {
    const r = await convertPdfBytes(await buildScannedPdf(5));
    expect(r.stats.every((s) => s.chars < 40)).toBe(true);
    expect(r.kind).toBe('scanned');
    expect(r.coverage.every((c) => c > 0.95)).toBe(true);
    expect(r.chapters).toEqual([]);
  });

  it('mede a cobertura de imagem de uma página de texto com figura grande', async () => {
    const r = await convertPdfBytes(await buildTextWithFigurePdf());
    expect(r.slideDeck).toBe(false);
    expect(r.coverage[0]).toBe(0);
    expect(r.coverage[1]).toBeGreaterThan(0.8);
    expect(r.coverage[2]).toBe(0);
  });

  it('PDFs de slides viram um capítulo por ~10 slides, com imagem e texto de cada slide', async () => {
    const slides = Array.from({ length: 25 }, (_, i) => ({
      title: `Slide número ${i + 1}`,
      lines: [`Primeiro ponto do slide ${i + 1}`, 'Segundo ponto importante'],
    }));
    const r = await convertPdfBytes(await buildSlidesPdf(slides, { footer: 'Universidade — Disciplina' }));
    expect(r.slideDeck).toBe(true);
    expect(r.chapters).toHaveLength(3);
    expect(r.chapters[0].title).toBe('Slide número 1');
    expect(r.chapters[1].title).toBe('Slide número 11');
    expect(r.chapters[2].title).toBe('Slide número 21');
    const first = r.chapters[0].blocks;
    expect(first[0]).toMatchObject({ t: 'img', src: 'p0001' });
    expect(first.filter((b) => b.t === 'img')).toHaveLength(10);
    // Títulos de slide viram parágrafos (nada de dezenas de h3 seguidos).
    expect(allBlocks(r.chapters).some((b) => b.t === 'h')).toBe(false);
    expect(allText(r.chapters)).toContain('Primeiro ponto do slide 25');
    expect(allText(r.chapters)).not.toContain('Universidade');
  });

  it('livro comum em retrato não é tratado como apresentação', async () => {
    const r = await convertPdfBytes(await buildBookPdf({ paragraphs: makeBody() }));
    expect(r.slideDeck).toBe(false);
  });
});

describe('PDF: robustez', () => {
  it('PDF corrompido lança erro legível', async () => {
    const garbage = new TextEncoder().encode('%PDF-1.4\nisso não é um pdf de verdade\n%%EOF');
    await expect(convertPdfBytes(garbage)).rejects.toThrow(/corrompido|inválido|Não foi possível ler o PDF/);
  });

  it('bytes aleatórios lançam erro legível', async () => {
    const bytes = new Uint8Array(500).map((_, i) => (i * 37) % 251);
    await expect(convertPdfBytes(bytes)).rejects.toThrow(/corrompido|inválido|Não foi possível ler o PDF/i);
  });

  it('PDF protegido por senha lança "PDF protegido por senha"', async () => {
    await expect(convertPdfBytes(buildPasswordPdf())).rejects.toThrow('PDF protegido por senha');
  });

  it('PDF sem páginas lança erro legível', async () => {
    await expect(convertPdfBytes(buildZeroPagesPdf())).rejects.toThrow(/páginas|corrompido|Não foi possível/);
  });

  it('PDF com páginas em branco (sem texto) converte para zero capítulos sem travar', async () => {
    const r = await convertPdfBytes(await buildEmptyPagesPdf(3));
    expect(r.numPages).toBe(3);
    expect(r.kind).toBe('scanned');
    expect(r.chapters).toEqual([]);
  });
});
