import { describe, expect, it } from 'vitest';
import { friendlyPdfError, imageAreaFraction, resolveFontInfo, titleFromFileName, type PdfOpsLike } from './pdf-extract';
import {
  buildSlideChapters,
  classifyPdf,
  hasFullPageImagePattern,
  isScannedPdf,
  isSlideDeck,
  median,
  shouldRenderPageImage,
  slideBlocks,
  slideTitle,
  type PageStat,
  type SlideInput,
} from './pdf-slides';

const land = (chars: number): PageStat => ({ width: 960, height: 540, chars });
const port = (chars: number): PageStat => ({ width: 595, height: 842, chars });
const many = (n: number, f: (c: number) => PageStat, chars: number) => Array.from({ length: n }, () => f(chars));

describe('isSlideDeck / classifyPdf (decisão pura)', () => {
  it('slides em paisagem com mediana baixa viram apresentação; livro em retrato com pouco texto não', () => {
    expect(isSlideDeck(many(20, land, 150))).toBe(true);
    expect(classifyPdf(many(20, land, 150))).toBe('slides');
    // Livros de poesia, teatro ou edição de bolso em retrato não devem cair no modo slides.
    expect(isSlideDeck(many(20, port, 150))).toBe(false);
    expect(classifyPdf(many(20, port, 150))).toBe('text');
  });

  it('PDFs mistos (escaneado + texto denso) não viram apresentação, em retrato ou paisagem', () => {
    const mixedPortrait = [...many(6, port, 0), ...many(4, port, 2500)];
    expect(isScannedPdf(mixedPortrait)).toBe(false);
    expect(isSlideDeck(mixedPortrait)).toBe(false);
    expect(classifyPdf(mixedPortrait)).toBe('text');

    const mixedLandscape = [...many(6, land, 0), ...many(4, land, 2500)];
    expect(isScannedPdf(mixedLandscape)).toBe(false);
    expect(isSlideDeck(mixedLandscape)).toBe(false);
    expect(classifyPdf(mixedLandscape)).toBe('text');
  });

  it('apostila em paisagem com divisórias curtas (< 40 chars) e slides curtos continua como slides', () => {
    const apostila = [...many(4, land, 15), ...many(16, land, 180)];
    expect(classifyPdf(apostila)).toBe('slides');
  });

  it('livro em retrato com texto cheio não é apresentação', () => {
    expect(isSlideDeck(many(100, port, 2200))).toBe(false);
    expect(classifyPdf(many(100, port, 2200))).toBe('text');
  });

  it('paisagem com texto moderado (até 1200) ainda é apresentação; acima disso, não', () => {
    expect(isSlideDeck(many(30, land, 900))).toBe(true);
    expect(isSlideDeck(many(30, land, 1500))).toBe(false);
  });

  it('usa a mediana, não a média: poucos slides cheios não mudam a decisão', () => {
    const stats = [...many(18, land, 120), ...many(2, land, 3000)];
    expect(median(stats.map((s) => s.chars))).toBe(120);
    expect(isSlideDeck(stats)).toBe(true);
  });

  it('um documento de uma página nunca é apresentação', () => {
    expect(isSlideDeck([land(50)])).toBe(false);
    expect(isSlideDeck([])).toBe(false);
  });

  it('escaneado tem prioridade sobre apresentação', () => {
    const scanned = many(20, land, 5);
    expect(isScannedPdf(scanned)).toBe(true);
    expect(classifyPdf(scanned)).toBe('scanned');
    expect(classifyPdf(many(20, land, 200))).toBe('slides');
    expect(isScannedPdf([])).toBe(false);
  });

  it('limite do escaneado: exatamente 70% das páginas sem texto ainda não é escaneado', () => {
    const stats = [...many(7, port, 0), ...many(3, port, 2000)];
    expect(isScannedPdf(stats)).toBe(false);
    expect(isScannedPdf([...many(8, port, 0), ...many(2, port, 2000)])).toBe(true);
  });

  it('median: vazio e par', () => {
    expect(median([])).toBe(0);
    expect(median([1, 3])).toBe(2);
  });
});

describe('shouldRenderPageImage e hasFullPageImagePattern', () => {
  it('só acima de 40% da área da página', () => {
    expect(shouldRenderPageImage(0.4)).toBe(false);
    expect(shouldRenderPageImage(0.41)).toBe(true);
    expect(shouldRenderPageImage(0)).toBe(false);
  });

  it('detecta PDF escaneado com camada OCR (imagem inteira em quase todas as páginas de texto)', () => {
    expect(hasFullPageImagePattern([0.98, 0.99, 1, 0.95, 0.97])).toBe(true);
    expect(hasFullPageImagePattern([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0, 0, 0])).toBe(true);
  });

  it('não suprime figuras pontuais nem documentos curtos de 1–2 páginas', () => {
    expect(hasFullPageImagePattern([0, 0.85, 0])).toBe(false);
    expect(hasFullPageImagePattern([0, 0, 0.8, 0, 0, 0.9, 0, 0, 0, 0.75])).toBe(false);
    expect(hasFullPageImagePattern([0.95, 0.95])).toBe(false);
    expect(hasFullPageImagePattern([])).toBe(false);
  });
});

describe('montagem dos slides', () => {
  const slide = (n: number, title: string, withImage = true): SlideInput => ({
    pageNumber: n,
    blocks: [
      { t: 'h', level: 3, text: title },
      { t: 'p', text: `Texto do slide ${n}` },
    ],
    ...(withImage ? { image: { src: `p${n}`, w: 1280, h: 720 } } : {}),
  });

  it('imagem vem primeiro; títulos viram parágrafos em negrito', () => {
    const blocks = slideBlocks(slide(1, 'Título'));
    expect(blocks[0]).toEqual({ t: 'img', src: 'p1', alt: 'Slide 1', w: 1280, h: 720 });
    expect(blocks[1]).toEqual({ t: 'p', text: 'Título', runs: [{ s: 'Título', b: 1 }] });
    expect(blocks[2]).toEqual({ t: 'p', text: 'Texto do slide 1' });
  });

  it('sem imagem renderizada, mantém só o texto', () => {
    const blocks = slideBlocks(slide(2, 'X', false));
    expect(blocks.some((b) => b.t === 'img')).toBe(false);
  });

  it('agrupa 10 por capítulo e titula pelo primeiro slide do grupo', () => {
    const chapters = buildSlideChapters(Array.from({ length: 23 }, (_, i) => slide(i + 1, `Tema ${i + 1}`)));
    expect(chapters.map((c) => c.title)).toEqual(['Tema 1', 'Tema 11', 'Tema 21']);
    expect(chapters[2].blocks.filter((b) => b.t === 'img')).toHaveLength(3);
  });

  it('título do slide: primeiro texto, cortado em 80 caracteres; slide vazio usa o número', () => {
    expect(slideTitle({ pageNumber: 4, blocks: [] })).toBe('Slide 4');
    const t = slideTitle({ pageNumber: 1, blocks: [{ t: 'p', text: 'a'.repeat(200) }] });
    expect(t.length).toBe(80);
    expect(t.endsWith('…')).toBe(true);
  });

  it('slide só com imagem (sem texto) ainda entra no capítulo', () => {
    const chapters = buildSlideChapters([
      { pageNumber: 1, blocks: [], image: { src: 'p1', w: 10, h: 10 } },
      { pageNumber: 2, blocks: [{ t: 'p', text: 'Olá' }], image: { src: 'p2', w: 10, h: 10 } },
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Olá');
    expect(chapters[0].blocks.filter((b) => b.t === 'img')).toHaveLength(2);
  });

  it('slides totalmente vazios não geram capítulo', () => {
    expect(buildSlideChapters([{ pageNumber: 1, blocks: [] }])).toEqual([]);
  });

  it('mantém imagens embutidas do texto quando o slide não tem imagem renderizada', () => {
    const blocks = slideBlocks({ pageNumber: 1, blocks: [{ t: 'img', src: 'k' }, { t: 'li', text: 'item' }] });
    expect(blocks).toEqual([{ t: 'img', src: 'k' }, { t: 'li', text: 'item' }]);
  });
});

describe('imageAreaFraction', () => {
  const ops: PdfOpsLike = {
    save: 10,
    restore: 11,
    transform: 12,
    paintFormXObjectBegin: 74,
    paintFormXObjectEnd: 75,
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
  };

  it('imagem cobrindo a página inteira = 1', () => {
    const f = imageAreaFraction([10, 12, 85, 11], [null, [200, 0, 0, 100, 0, 0], ['img', 1, 1], null], ops, 200, 100);
    expect(f).toBeCloseTo(1);
  });

  it('metade da página; save/restore isolam a matriz', () => {
    const f = imageAreaFraction(
      [10, 12, 85, 11, 10, 12, 85, 11],
      [null, [100, 0, 0, 100, 0, 0], ['a'], null, null, [1, 0, 0, 1, 0, 0], ['b'], null],
      ops,
      200,
      100,
    );
    // primeira imagem: 100x100 = 0.5; segunda com CTM identidade = 1x1 (desprezível)
    expect(f).toBeCloseTo(0.5, 2);
  });

  it('formulário XObject aplica sua matriz e imagens inline contam', () => {
    const f = imageAreaFraction([74, 86, 75], [[[100, 0, 0, 50, 0, 0]], ['i'], null], ops, 200, 100);
    expect(f).toBeCloseTo(0.25);
  });

  it('limita a 1, ignora página inválida e restore sem save', () => {
    expect(imageAreaFraction([12, 85, 85], [[500, 0, 0, 500, 0, 0], [], []], ops, 100, 100)).toBe(1);
    expect(imageAreaFraction([85], [[]], ops, 0, 0)).toBe(0);
    expect(imageAreaFraction([11, 85], [null, []], ops, 10, 10)).toBeCloseTo(0.01);
  });

  it('rotação não altera a área (determinante)', () => {
    const f = imageAreaFraction([12, 85], [[0, 100, -100, 0, 100, 0], []], ops, 100, 100);
    expect(f).toBeCloseTo(1);
  });
});

describe('friendlyPdfError e utilitários', () => {
  it('traduz erros do pdf.js', () => {
    expect(friendlyPdfError({ name: 'PasswordException', message: 'No password given' }).message).toMatch(/protegido por senha/);
    expect(friendlyPdfError({ name: 'InvalidPDFException' }).message).toMatch(/corrompido/);
    expect(friendlyPdfError({ name: 'MissingPDFException' }).message).toMatch(/não encontrado/);
    expect(friendlyPdfError(new Error('boom')).message).toBe('Não foi possível ler o PDF (boom).');
    expect(friendlyPdfError(null).message).toBe('Não foi possível ler o PDF.');
    const own = new Error('PDF protegido por senha');
    expect(friendlyPdfError(own)).toBe(own);
  });

  it('titleFromFileName', () => {
    expect(titleFromFileName('/tmp/meu_livro__bom.pdf')).toBe('meu livro bom');
    expect(titleFromFileName('.pdf')).toBe('Sem título');
  });

  it('resolveFontInfo usa loadedName e as flags bold/italic do pdf.js 6', () => {
    const page = {
      commonObjs: {
        has: (n: string) => n !== 'ausente',
        get: () => ({ loadedName: 'Helvetica', bold: true, italic: false }),
      },
    };
    const styles = { f1: { fontFamily: 'sans-serif' } };
    expect(resolveFontInfo(page as never, 'f1', styles)).toEqual({ name: 'Helvetica sans-serif', bold: true });
    expect(resolveFontInfo(page as never, 'ausente', styles)).toEqual({ name: 'ausente' });
    const throwing = { commonObjs: { has: () => { throw new Error('x'); }, get: () => null } };
    expect(resolveFontInfo(throwing as never, 'f1', styles)).toEqual({ name: 'f1 sans-serif' });
  });
});

describe('extractOutline / readPdfInfo com documento simulado', () => {
  const makeDoc = (outline: unknown, numPages = 10) => ({
    numPages,
    getOutline: async () => outline as unknown[] | null,
    getDestination: async (id: string) => (id === 'cap2' ? [{ num: 5 }] : null),
    getPageIndex: async (ref: { num: number }) => ref.num,
    getMetadata: async () => ({ info: { Title: '  Meu Título ', Author: 42 } }),
  });

  it('achata o sumário com níveis, resolve destinos nomeados, por índice e por referência', async () => {
    const { extractOutline } = await import('./pdf-extract');
    const doc = makeDoc([
      { title: 'Parte I', dest: [0], items: [{ title: 'Cap 1', dest: [{ num: 2 }] }, { title: 'Cap 2', dest: 'cap2' }] },
      { title: '', dest: [1] },
      { title: 'Fora do intervalo', dest: [99] },
      { title: 'Sem destino', dest: null },
      { title: 'Destino inválido', dest: 'inexistente' },
    ]);
    expect(await extractOutline(doc as never)).toEqual([
      { title: 'Parte I', pageNumber: 1, level: 0 },
      { title: 'Cap 1', pageNumber: 3, level: 1 },
      { title: 'Cap 2', pageNumber: 6, level: 1 },
    ]);
  });

  it('sumário ausente, vazio ou com erro vira lista vazia', async () => {
    const { extractOutline } = await import('./pdf-extract');
    expect(await extractOutline(makeDoc(null) as never)).toEqual([]);
    expect(await extractOutline(makeDoc([]) as never)).toEqual([]);
    const broken = { ...makeDoc([]), getOutline: async () => { throw new Error('x'); } };
    expect(await extractOutline(broken as never)).toEqual([]);
  });

  it('readPdfInfo corta espaços e ignora tipos inesperados', async () => {
    const { readPdfInfo } = await import('./pdf-extract');
    expect(await readPdfInfo(makeDoc([]) as never)).toEqual({ title: 'Meu Título', author: '' });
    const noMeta = { ...makeDoc([]), getMetadata: async () => { throw new Error('x'); } };
    expect(await readPdfInfo(noMeta as never)).toEqual({ title: '', author: '' });
  });
});

describe('extractPdfPageBlocks e fallbackImage', () => {
  const item = (str: string, y: number) => ({ str, x: 50, y, w: str.length * 6, h: 12, fontName: 'Helv' });
  const page = (n: number, withImage = false) => ({
    pageNumber: n,
    width: 400,
    height: 600,
    items: [item(`Texto da página ${n} com palavras suficientes para formar uma linha.`, 100)],
    ...(withImage ? { fallbackImage: { src: `p${n}`, w: 800, h: 1200 } } : {}),
  });

  it('devolve os blocos por página, mantendo páginas vazias', async () => {
    const { extractPdfPageBlocks } = await import('./pdf-layout');
    const out = extractPdfPageBlocks([page(1), { ...page(2), items: [] }, page(3)], { yOrigin: 'top-down' });
    expect(out.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(out[1].blocks).toEqual([]);
    expect(out[0].blocks[0]).toMatchObject({ t: 'p' });
    expect(await extractPdfPageBlocks([])).toEqual([]);
  });

  it('página de texto com figura grande ganha o bloco img depois do texto', async () => {
    const { extractPdfChapters } = await import('./pdf-layout');
    const chapters = extractPdfChapters([page(1), page(2, true), page(3)], { yOrigin: 'top-down' });
    const blocks = chapters.flatMap((c) => c.blocks);
    const imgIdx = blocks.findIndex((b) => b.t === 'img');
    expect(imgIdx).toBeGreaterThan(0);
    expect(blocks[imgIdx]).toMatchObject({ src: 'p2', alt: 'Página 2' });
    expect(blocks[imgIdx - 1]).toMatchObject({ t: 'p', text: expect.stringContaining('página 2') });
  });
});
