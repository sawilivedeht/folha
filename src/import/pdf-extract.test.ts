import { describe, expect, it } from 'vitest';
import { buildOcrPdf, buildRotatedStampPdf } from '../../test/fixtures/pdf-fixtures';
import { allText, convertPdfBytes } from '../../test/fixtures/pdf-node';
import {
  extractPageText,
  imageAreaFraction,
  waitForPageFonts,
  type PdfOpsLike,
  type PdfPageLike,
} from './pdf-extract';
import { hasFullPageImagePattern } from './pdf-slides';

function makeSimulatedPage(opts: {
  width?: number;
  height?: number;
  transform?: number[];
  items: Array<{ str: string; transform: number[]; width: number; height: number; fontName: string }>;
  styles?: Record<string, { fontFamily?: string } | undefined>;
  commonObjs?: PdfPageLike['commonObjs'];
}): PdfPageLike {
  const width = opts.width ?? 595;
  const height = opts.height ?? 842;
  const viewportTransform = opts.transform ?? [1, 0, 0, -1, 0, height];
  return {
    getViewport: () => ({ width, height, transform: viewportTransform }),
    getTextContent: async () => ({ items: opts.items, styles: opts.styles ?? {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: opts.commonObjs,
  };
}

describe('extractPageText: resolução assíncrona de fontes (achado 7)', () => {
  it('aguarda fonte pendente em commonObjs antes de resolver negrito/itálico', async () => {
    const resolved = new Map<string, { loadedName: string; bold?: boolean; italic?: boolean }>();
    const page = makeSimulatedPage({
      items: [
        { str: 'Palavra em negrito', transform: [12, 0, 0, 12, 50, 700], width: 100, height: 12, fontName: 'g_d0_f1' },
        { str: 'e itálico', transform: [12, 0, 0, 12, 160, 700], width: 60, height: 12, fontName: 'g_d0_f2' },
      ],
      styles: {
        g_d0_f1: { fontFamily: 'sans-serif' },
        g_d0_f2: { fontFamily: 'sans-serif' },
      },
      commonObjs: {
        has: (name: string) => resolved.has(name),
        get: (name: string, callback?: (data: unknown) => void) => {
          if (resolved.has(name)) {
            const val = resolved.get(name);
            callback?.(val);
            return val;
          }
          if (callback) {
            setTimeout(() => {
              const font =
                name === 'g_d0_f1'
                  ? { loadedName: 'FonteNegrito', bold: true, italic: false }
                  : { loadedName: 'FonteItalico', bold: false, italic: true };
              resolved.set(name, font);
              callback(font);
            }, 10);
          }
          return undefined;
        },
      },
    });

    const { pageInput } = await extractPageText(page, 2, { fontWaitTimeoutMs: 200 });
    expect(pageInput.items[0]).toMatchObject({ str: 'Palavra em negrito', bold: true });
    expect(pageInput.items[0].fontName).toContain('FonteNegrito');
    expect(pageInput.items[1]).toMatchObject({ str: 'e itálico', italic: true });
    expect(pageInput.items[1].fontName).toContain('FonteItalico');
  });

  it('respeita o limite curto de espera quando uma fonte nunca resolve', async () => {
    const page = makeSimulatedPage({
      items: [{ str: 'Texto normal', transform: [12, 0, 0, 12, 50, 700], width: 80, height: 12, fontName: 'g_d0_f9' }],
      styles: { g_d0_f9: { fontFamily: 'serif' } },
      commonObjs: {
        has: () => false,
        get: () => undefined,
      },
    });

    const start = Date.now();
    const { pageInput } = await extractPageText(page, 3, { fontWaitTimeoutMs: 30 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(150);
    expect(pageInput.items[0].fontName).toBe('g_d0_f9 serif');
  });

  it('retorna imediatamente quando todas as fontes já estão disponíveis', async () => {
    let getCalls = 0;
    const page = makeSimulatedPage({
      items: [],
      commonObjs: {
        has: () => true,
        get: () => {
          getCalls++;
          return { loadedName: 'Helvetica' };
        },
      },
    });
    await waitForPageFonts(page, ['f1', 'f2'], 500);
    expect(getCalls).toBe(0);
  });
});

describe('extractPageText: texto rotacionado (achado 8)', () => {
  it('descarta itens verticais (90°/270°), invertidos (180°) e diagonais (45°)', async () => {
    const page = makeSimulatedPage({
      items: [
        { str: 'Texto horizontal', transform: [12, 0, 0, 12, 60, 700], width: 120, height: 12, fontName: 'f1' },
        { str: 'arXiv:2401.12345', transform: [0, 12, -12, 0, 20, 400], width: 250, height: 12, fontName: 'f1' },
        { str: 'Vertical descendo', transform: [0, -12, 12, 0, 560, 500], width: 200, height: 12, fontName: 'f1' },
        { str: 'De ponta cabeça', transform: [-12, 0, 0, -12, 300, 680], width: 100, height: 12, fontName: 'f1' },
        { str: 'RASCUNHO', transform: [8.5, 8.5, -8.5, 8.5, 150, 400], width: 140, height: 12, fontName: 'f1' },
      ],
    });

    const { pageInput, charCount } = await extractPageText(page, 1);
    expect(pageInput.items.map((i) => i.str)).toEqual(['Texto horizontal']);
    expect(charCount).toBe('Textohorizontal'.length);
  });

  it('mantém texto legível em páginas com /Rotate 90 e descarta selos perpendiculares', async () => {
    // Em uma página com /Rotate 90, o texto horizontal legível corre ao longo de +y no espaço PDF.
    const page = makeSimulatedPage({
      width: 842,
      height: 595,
      transform: [0, 1, 1, 0, 0, 0],
      items: [
        { str: 'Linha horizontal legível', transform: [0, 12, -12, 0, 100, 60], width: 180, height: 12, fontName: 'f1' },
        { str: 'Selo vertical na margem', transform: [12, 0, 0, 12, 20, 200], width: 160, height: 12, fontName: 'f1' },
      ],
    });

    const { pageInput } = await extractPageText(page, 1);
    expect(pageInput.items.map((i) => i.str)).toEqual(['Linha horizontal legível']);
  });

  it('em PDF real com selo arXiv rotacionado 90° e texto 180°, não mistura nas linhas horizontais', async () => {
    const result = await convertPdfBytes(await buildRotatedStampPdf());
    const text = allText(result.chapters);
    expect(text).toContain('Primeira linha do artigo científico');
    expect(text).toContain('Segunda linha do artigo');
    expect(text).not.toContain('arXiv:2401.12345v1');
    expect(text).not.toContain('TEXTO INVERTIDO 180');
  });
});

describe('imageAreaFraction e padrão OCR (achado 3)', () => {
  it('contabiliza OPS.paintImageMaskXObject (imagens 1-bit P&B) quando presente', () => {
    const ops: PdfOpsLike = {
      save: 10,
      restore: 11,
      transform: 12,
      paintFormXObjectBegin: 74,
      paintFormXObjectEnd: 75,
      paintImageXObject: 85,
      paintInlineImageXObject: 86,
      paintImageMaskXObject: 83,
    };
    const f = imageAreaFraction([10, 12, 83, 11], [null, [150, 0, 0, 100, 0, 0], ['mask'], null], ops, 200, 100);
    expect(f).toBeCloseTo(0.75);
  });

  it('PDF real com camada OCR sobre imagem inteira é reconhecido como texto com padrão de imagem inteira', async () => {
    const result = await convertPdfBytes(await buildOcrPdf(5));
    expect(result.kind).toBe('text');
    expect(result.coverage.every((c) => c > 0.95)).toBe(true);
    expect(hasFullPageImagePattern(result.coverage)).toBe(true);
  });
});
