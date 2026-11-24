import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBookPdf,
  buildPasswordPdf,
  buildScannedPdf,
  buildSlidesPdf,
  buildZeroPagesPdf,
} from '../../test/fixtures/pdf-fixtures';
import {
  computeRenderSize,
  DOC_CLEANUP_INTERVAL,
  getPdfAssetUrls,
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  parsePdf,
} from './pdf';

const { getDocumentSpy, defaultGetDocument, opsRef } = vi.hoisted(() => ({
  getDocumentSpy: vi.fn(),
  defaultGetDocument: { fn: null as null | ((...args: unknown[]) => unknown) },
  opsRef: {
    ops: {
      save: 10,
      restore: 11,
      transform: 12,
      paintImageXObject: 85,
    },
  },
}));

// O pdf.js "normal" depende de APIs de navegador; nos testes usamos a build legacy, que roda no Node.
vi.mock('pdfjs-dist', async () => {
  const actual = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const realGetDocument = actual.getDocument as unknown as (...args: unknown[]) => unknown;
  defaultGetDocument.fn = realGetDocument;
  opsRef.ops = {
    save: actual.OPS.save,
    restore: actual.OPS.restore,
    transform: actual.OPS.transform,
    paintImageXObject: actual.OPS.paintImageXObject,
  };
  getDocumentSpy.mockImplementation((...args: unknown[]) => realGetDocument(...args));
  return {
    ...actual,
    getDocument: (...args: unknown[]) => getDocumentSpy(...args),
  };
});
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const noop = () => {};

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
  readonly getImageDataCalls: Array<{ w: number; h: number }> = [];
  drawImageCalls = 0;

  static instances: FakeOffscreenCanvas[] = [];
  static probePixel: [number, number, number, number] = [255, 255, 255, 255];

  static reset(): void {
    FakeOffscreenCanvas.instances = [];
    FakeOffscreenCanvas.probePixel = [255, 255, 255, 255];
  }

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initialWidth = width;
    this.initialHeight = height;
    FakeOffscreenCanvas.instances.push(this);
  }

  getContext(_type: string) {
    return {
      fillStyle: '',
      fillRect: () => {},
      drawImage: () => {
        this.drawImageCalls++;
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        this.getImageDataCalls.push({ w, h });
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = FakeOffscreenCanvas.probePixel[0];
          data[i + 1] = FakeOffscreenCanvas.probePixel[1];
          data[i + 2] = FakeOffscreenCanvas.probePixel[2];
          data[i + 3] = FakeOffscreenCanvas.probePixel[3];
        }
        return { data };
      },
    };
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
  }
}

interface FakePageSpec {
  width?: number;
  height?: number;
  chars?: number;
  imageCoverage?: number;
  failRender?: boolean;
}

function makeFakeLoadingTask(pages: FakePageSpec[]) {
  const docCleanup = vi.fn(async () => {});
  const taskDestroy = vi.fn(async () => {});
  const renderCalls: number[] = [];

  const doc = {
    numPages: pages.length,
    getMetadata: async () => ({ info: {} }),
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
    cleanup: docCleanup,
    getPage: async (pageNum: number) => {
      const spec = pages[pageNum - 1];
      const w = spec.width ?? 595;
      const h = spec.height ?? 842;
      const cov = spec.imageCoverage ?? 0;
      const chars = spec.chars ?? 0;
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: w * scale,
          height: h * scale,
          transform: [scale, 0, 0, -scale, 0, h * scale],
        }),
        getOperatorList: async () => {
          if (cov <= 0) return { fnArray: [], argsArray: [] };
          const { save, transform, paintImageXObject, restore } = opsRef.ops;
          return {
            fnArray: [save, transform, paintImageXObject, restore],
            argsArray: [null, [w * cov, 0, 0, h, 0, 0], ['im1'], null],
          };
        },
        getTextContent: async () => ({
          items:
            chars > 0
              ? [
                  {
                    str: `Página ${pageNum}: ${'texto '.repeat(Math.ceil(chars / 5)).slice(0, chars)}`,
                    transform: [12, 0, 0, 12, 50, h - 100],
                    width: 400,
                    height: 12,
                    fontName: 'f1',
                  },
                ]
              : [],
          styles: chars > 0 ? { f1: { fontFamily: 'sans-serif' } } : {},
        }),
        commonObjs: {
          has: () => true,
          get: () => ({ loadedName: 'Helvetica', bold: false, italic: false }),
        },
        render: () => {
          renderCalls.push(pageNum);
          if (spec.failRender) {
            return { promise: Promise.reject(new Error(`falha na página ${pageNum}`)) };
          }
          return { promise: Promise.resolve() };
        },
        cleanup: vi.fn(() => true),
      };
    },
  };

  return {
    loadingTask: {
      promise: Promise.resolve(doc),
      destroy: taskDestroy,
    },
    docCleanup,
    taskDestroy,
    renderCalls,
  };
}

beforeEach(() => {
  FakeOffscreenCanvas.reset();
  getDocumentSpy.mockClear();
  if (defaultGetDocument.fn) {
    getDocumentSpy.mockImplementation(defaultGetDocument.fn);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePdf (sem canvas, no Node)', () => {
  it('converte um livro de texto em capítulos refluíveis', async () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Parágrafo número ${i + 1} do livro de teste, com acentuação e bastante texto para formar linhas completas na página.`,
    );
    const bytes = await buildBookPdf({ paragraphs, headings: [{ before: 0, text: 'Início da Obra', size: 22 }] });
    const book = await parsePdf(toBuffer(bytes), 'meu_livro_teste.pdf', noop);
    expect(book.title).toBe('meu livro teste');
    expect(book.fixedLayout).toBeUndefined();
    expect(book.chapters[0].title).toBe('Início da Obra');
    expect(book.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'p')).toHaveLength(10);
  });

  it('PDF de slides vira capítulos de ~10 slides com o texto de cada um', async () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({
      title: `Tema ${i + 1}`,
      lines: ['primeiro ponto importante do tema', 'segundo ponto importante do tema'],
    }));
    const progress: number[] = [];
    const book = await parsePdf(toBuffer(await buildSlidesPdf(slides)), 'aula.pdf', (f) => progress.push(f));
    expect(book.fixedLayout).toBeUndefined();
    expect(book.chapters.map((c) => c.title)).toEqual(['Tema 1', 'Tema 11']);
    expect(book.chapters[1].blocks.some((b) => b.t === 'p' && b.text === 'Tema 12')).toBe(true);
    expect(book.chapters.flatMap((c) => c.blocks).some((b) => b.t === 'h')).toBe(false);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('PDF escaneado sem canvas devolve fixedLayout com aviso', async () => {
    const book = await parsePdf(toBuffer(await buildScannedPdf(4)), 'scan.pdf', noop);
    expect(book.fixedLayout).toBe(true);
    expect(book.warnings?.[0]).toMatch(/escaneado/);
    expect(book.chapters).toEqual([]);
  });

  it('PDF com senha lança "PDF protegido por senha"', async () => {
    await expect(parsePdf(toBuffer(buildPasswordPdf()), 'x.pdf', noop)).rejects.toThrow('PDF protegido por senha');
  });

  it('PDF corrompido lança erro legível em português', async () => {
    const bad = new TextEncoder().encode('%PDF-1.7 lixo lixo lixo');
    await expect(parsePdf(toBuffer(bad), 'x.pdf', noop)).rejects.toThrow(/PDF|corrompido/);
  });

  it('PDF de 0 páginas lança erro legível', async () => {
    await expect(parsePdf(toBuffer(buildZeroPagesPdf()), 'x.pdf', noop)).rejects.toThrow(/páginas|corrompido|PDF/);
  });
});

describe('parsePdf: memória e limpeza periódica (achado 1)', () => {
  it('não faz segunda cópia do ArrayBuffer antes de passar ao pdf.js', async () => {
    const bytes = await buildBookPdf({ paragraphs: ['Um parágrafo simples para validar o buffer sem cópia dupla.'] });
    const inputBuffer = toBuffer(bytes);
    await parsePdf(inputBuffer, 'unico.pdf', noop);
    const params = getDocumentSpy.mock.calls[0][0] as { data: Uint8Array };
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect(params.data.buffer).toBe(inputBuffer);
  });

  it('chama doc.cleanup() periodicamente em PDFs longos', async () => {
    const pages = Array.from({ length: DOC_CLEANUP_INTERVAL + 5 }, () => ({ chars: 600 }));
    const { loadingTask, docCleanup } = makeFakeLoadingTask(pages);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    await parsePdf(new ArrayBuffer(16), 'longo.pdf', noop);
    expect(docCleanup).toHaveBeenCalledTimes(1);
  });
});

describe('parsePdf: limites de canvas, limpeza em finally e isolamento de erros (achado 2)', () => {
  it('computeRenderSize limita lado e área sem distorcer páginas normais', () => {
    const a4 = computeRenderSize(595, 842, 1200);
    expect(a4).not.toBeNull();
    expect(a4!.width).toBe(1200);
    expect(a4!.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(a4!.width * a4!.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);

    const longWeb = computeRenderSize(595, 14000, 1200);
    expect(longWeb).not.toBeNull();
    expect(longWeb!.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(longWeb!.width * longWeb!.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);

    const bigSquare = computeRenderSize(2000, 2000, 2400);
    expect(bigSquare).not.toBeNull();
    expect(bigSquare!.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(bigSquare!.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(bigSquare!.width * bigSquare!.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);

    expect(computeRenderSize(0, 800, 1200)).toBeNull();
  });

  it('modo escaneado isola erro por página, zera canvas em finally e adiciona aviso', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const { loadingTask } = makeFakeLoadingTask([
      { width: 595, height: 14000, chars: 0, failRender: true },
      { width: 595, height: 14000, chars: 0, failRender: false },
    ]);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    const book = await parsePdf(new ArrayBuffer(16), 'scan-longo.pdf', noop);
    expect(book.fixedLayout).toBe(true);
    expect(book.images.size).toBe(1);
    expect(book.chapters).toHaveLength(1);
    expect(book.warnings?.some((w) => /Não foi possível renderizar 1 página escaneada/.test(w))).toBe(true);

    // Todos os canvases criados respeitaram o teto e foram zerados no finally (inclusive o que falhou).
    expect(FakeOffscreenCanvas.instances.length).toBeGreaterThan(0);
    for (const c of FakeOffscreenCanvas.instances) {
      expect(c.initialWidth).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(c.initialHeight).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(c.initialWidth * c.initialHeight).toBeLessThanOrEqual(MAX_CANVAS_AREA);
      expect(c.width).toBe(0);
      expect(c.height).toBe(0);
    }
  });

  it('isCanvasMostlyBlank usa canvas reduzido de amostragem em vez de ler o canvas inteiro', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.probePixel = [255, 255, 255, 255];
    const { loadingTask } = makeFakeLoadingTask([
      { chars: 800 },
      { chars: 0 }, // página sem texto e toda branca -> deve ser ignorada via probe reduzido
      { chars: 800 },
    ]);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    const book = await parsePdf(new ArrayBuffer(16), 'com-branco.pdf', noop);
    expect(book.images.size).toBe(0);

    const fullSizeCanvases = FakeOffscreenCanvas.instances.filter((c) => c.initialWidth >= 1000);
    const probeCanvases = FakeOffscreenCanvas.instances.filter((c) => c.getImageDataCalls.length > 0);
    expect(fullSizeCanvases.length).toBe(1);
    expect(fullSizeCanvases[0].getImageDataCalls).toEqual([]);
    expect(probeCanvases.length).toBe(1);
    expect(probeCanvases[0].getImageDataCalls[0].w).toBeLessThanOrEqual(48);
    expect(probeCanvases[0].getImageDataCalls[0].h).toBeLessThanOrEqual(48);
    expect(probeCanvases[0].width).toBe(0);
    expect(probeCanvases[0].height).toBe(0);
  });
});

describe('parsePdf: camada OCR e progresso nas imagens (achado 3)', () => {
  it('não gera imagens de página para texto quando quase todas as páginas têm imagem inteira (OCR)', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const { loadingTask, renderCalls } = makeFakeLoadingTask([
      { chars: 900, imageCoverage: 0.98 },
      { chars: 950, imageCoverage: 0.99 },
      { chars: 870, imageCoverage: 1 },
      { chars: 910, imageCoverage: 0.97 },
      { chars: 920, imageCoverage: 0.96 },
    ]);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    const book = await parsePdf(new ArrayBuffer(16), 'livro-ocr.pdf', noop);
    expect(book.fixedLayout).toBeUndefined();
    expect(book.images.size).toBe(0);
    // Só a página 1 foi renderizada (para a capa).
    expect(renderCalls).toEqual([1]);
    expect(book.chapters.flatMap((c) => c.blocks).some((b) => b.t === 'p')).toBe(true);
  });

  it('reporta progresso durante o loop de imagens pontuais no modo texto', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const { loadingTask } = makeFakeLoadingTask([
      { chars: 900, imageCoverage: 0 },
      { chars: 900, imageCoverage: 0.85 },
      { chars: 900, imageCoverage: 0 },
    ]);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    const events: Array<{ fraction: number; label: string }> = [];
    const book = await parsePdf(new ArrayBuffer(16), 'com-figura.pdf', (fraction, label) => {
      events.push({ fraction, label });
    });

    expect(book.images.size).toBe(1);
    const imgProgress = events.find((e) => /Renderizando imagem 1 de 1/.test(e.label));
    expect(imgProgress).toBeDefined();
    expect(imgProgress!.fraction).toBeGreaterThanOrEqual(0.85);
    expect(imgProgress!.fraction).toBeLessThan(0.95);
  });
});

describe('parsePdf: URLs de cmaps, fontes padrão e WASM (achado 11)', () => {
  it('resolve cMapUrl, standardFontDataUrl e wasmUrl relativos à base da página e do APK', () => {
    expect(getPdfAssetUrls('https://localhost/index.html')).toEqual({
      cMapUrl: 'https://localhost/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://localhost/pdfjs/standard_fonts/',
      wasmUrl: 'https://localhost/pdfjs/wasm/',
    });
    expect(getPdfAssetUrls('https://exemplo.com/folha/index.html#/ler/1')).toEqual({
      cMapUrl: 'https://exemplo.com/folha/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://exemplo.com/folha/pdfjs/standard_fonts/',
      wasmUrl: 'https://exemplo.com/folha/pdfjs/wasm/',
    });
  });

  it('passa wasmUrl, cMapUrl (cMapPacked), standardFontDataUrl e limites de imagem ao getDocument no navegador', async () => {
    vi.stubGlobal('location', { href: 'https://localhost/index.html' });
    const { loadingTask } = makeFakeLoadingTask([{ chars: 600 }]);
    getDocumentSpy.mockImplementationOnce(() => loadingTask);

    await parsePdf(new ArrayBuffer(16), 'apk.pdf', noop);
    const params = getDocumentSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.cMapUrl).toBe('https://localhost/pdfjs/cmaps/');
    expect(params.cMapPacked).toBe(true);
    expect(params.standardFontDataUrl).toBe('https://localhost/pdfjs/standard_fonts/');
    expect(params.wasmUrl).toBe('https://localhost/pdfjs/wasm/');
    expect(params.maxImageSize).toBeGreaterThan(0);
    expect(params.canvasMaxAreaInBytes).toBe(MAX_CANVAS_AREA * 4);
  });
});
