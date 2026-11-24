// Importador de PDF para ParsedBook usando pdfjs-dist com Web Worker.
// Carregado sob demanda via import dinâmico.
// Build "legacy": o build padrão do pdf.js 6.5 usa Promise.try (Chrome 128+) e trava sem erro em WebViews
// Android mais antigos (testado no WebView 124); o legacy traz os polyfills necessários.
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { Block, Chapter, ParsedBook, ProgressFn } from '../types';
import { extractPdfChapters, extractPdfPageBlocks, type PdfPageInput } from './pdf-layout';
import {
  extractOutline,
  extractPageText,
  friendlyPdfError,
  measurePageImageCoverage,
  readPdfInfo,
  titleFromFileName,
  type PdfDocLike,
  type PdfPageLike,
} from './pdf-extract';
import {
  buildSlideChapters,
  classifyPdf,
  hasFullPageImagePattern,
  shouldRenderPageImage,
  type PageStat,
  type SlideInput,
} from './pdf-slides';

if (typeof workerUrl === 'string' && workerUrl.length > 0) {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

type PdfDoc = Awaited<ReturnType<typeof getDocument>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>;

const COVER_TARGET_WIDTH = 360;
const COVER_JPEG_QUALITY = 0.8;
const SCAN_TARGET_WIDTH = 1200;
const SLIDE_TARGET_WIDTH = 1280;
const SLIDE_JPEG_QUALITY = 0.8;
const SCAN_JPEG_QUALITY = 0.75;
const SCANNED_PAGES_PER_CHAPTER = 20;

/** Limite de lado e área do canvas para evitar estouro de textura/RAM no Android WebView. */
export const MAX_CANVAS_SIDE = 2400;
export const MAX_CANVAS_AREA = 3_000_000;
/** Intervalo de páginas entre limpezas de cache/fontes do documento em PDFs longos. */
export const DOC_CLEANUP_INTERVAL = 40;
const MAX_PDF_IMAGE_PIXELS = 16_000_000;
const BLANK_PROBE_MAX_SIDE = 48;

function canRenderCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
}

function formatPageImageKey(pageNumber: number): string {
  return `p${String(pageNumber).padStart(4, '0')}`;
}

function tryResolveBaseUrl(base: string, relative: string): string | null {
  try {
    const resolved = new URL(relative, base).href;
    // Só usa URLs hierárquicas que o Web Worker pode buscar via fetch (evita about:blank).
    if (/^(?:https?|capacitor|file):/i.test(resolved)) return resolved;
  } catch {
    // Base inválida ou não hierárquica.
  }
  return null;
}

/**
 * URLs relativas à base do app (`base: './'`) para cmaps, fontes padrão e decodificadores de imagem
 * do pdf.js (`wasm/` só leva as versões em JavaScript; veja `useWasm` em `parsePdf`).
 * Resolver contra a base da página garante que o Web Worker em `./assets/` encontre `./pdfjs/`.
 */
export function getPdfAssetUrls(baseUrl?: string): {
  cMapUrl: string;
  cMapPacked: true;
  standardFontDataUrl: string;
  wasmUrl: string;
} {
  const base =
    baseUrl ??
    (typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined' && location.href
        ? location.href
        : undefined);
  const resolveDir = (dir: string): string => {
    const rel = `./pdfjs/${dir}/`;
    if (!base) return rel;
    return tryResolveBaseUrl(base, rel) ?? rel;
  };
  return {
    cMapUrl: resolveDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: resolveDir('standard_fonts'),
    wasmUrl: resolveDir('wasm'),
  };
}

/** Calcula escala e dimensões do canvas respeitando os tetos de lado (`MAX_CANVAS_SIDE`) e área (`MAX_CANVAS_AREA`). */
export function computeRenderSize(
  baseWidth: number,
  baseHeight: number,
  targetWidth: number,
): { scale: number; width: number; height: number } | null {
  if (!(baseWidth > 0) || !(baseHeight > 0) || !(targetWidth > 0)) return null;
  let scale = targetWidth / baseWidth;
  const maxSideScale = MAX_CANVAS_SIDE / Math.max(baseWidth, baseHeight);
  if (scale > maxSideScale) scale = maxSideScale;
  const maxAreaScale = Math.sqrt(MAX_CANVAS_AREA / (baseWidth * baseHeight));
  if (scale > maxAreaScale) scale = maxAreaScale;

  let width = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(baseWidth * scale)));
  let height = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(baseHeight * scale)));
  if (width * height > MAX_CANVAS_AREA) {
    width = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(baseWidth * scale)));
    height = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(baseHeight * scale)));
  }
  return { scale, width, height };
}

function sampleProbePixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  probeW: number,
  probeH: number,
): ImageData['data'] | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const probe = new OffscreenCanvas(probeW, probeH);
    try {
      const ctx = probe.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, probeW, probeH);
      ctx.drawImage(source, 0, 0, width, height, 0, 0, probeW, probeH);
      return ctx.getImageData(0, 0, probeW, probeH).data;
    } finally {
      probe.width = 0;
      probe.height = 0;
    }
  }
  if (typeof document !== 'undefined') {
    const probe = document.createElement('canvas');
    probe.width = probeW;
    probe.height = probeH;
    try {
      const ctx = probe.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, probeW, probeH);
      ctx.drawImage(source, 0, 0, width, height, 0, 0, probeW, probeH);
      return ctx.getImageData(0, 0, probeW, probeH).data;
    } finally {
      probe.width = 0;
      probe.height = 0;
    }
  }
  return null;
}

/** Verifica rapidamente se o canvas renderizado está praticamente todo branco via amostragem em miniatura. */
function isCanvasMostlyBlank(
  source: CanvasImageSource,
  width: number,
  height: number,
): boolean {
  try {
    const scale = Math.min(1, BLANK_PROBE_MAX_SIDE / Math.max(width, height));
    const probeW = Math.max(1, Math.round(width * scale));
    const probeH = Math.max(1, Math.round(height * scale));
    const data = sampleProbePixels(source, width, height, probeW, probeH);
    if (!data) return false;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 248 || data[i + 1] < 248 || data[i + 2] < 248) {
        nonWhite++;
        if (nonWhite >= 4) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function cleanupDoc(doc: PdfDoc): Promise<void> {
  if (typeof doc.cleanup !== 'function') return;
  try {
    await doc.cleanup();
  } catch {
    // Limpeza periódica é apenas alívio de memória e não deve interromper a importação.
  }
}

async function renderPageToJpeg(
  page: PdfPage,
  targetWidth: number,
  quality: number,
  skipIfBlank = false,
): Promise<{ blob: Blob; w: number; h: number } | null> {
  if (!canRenderCanvas()) return null;

  const baseViewport = page.getViewport({ scale: 1 });
  const sized = computeRenderSize(baseViewport.width, baseViewport.height, targetWidth);
  if (!sized) return null;

  const viewport = page.getViewport({ scale: sized.scale });
  const { width, height } = sized;

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      if (skipIfBlank && isCanvasMostlyBlank(canvas, width, height)) {
        return null;
      }

      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      return { blob, w: width, h: height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
    }).promise;

    if (skipIfBlank && isCanvasMostlyBlank(canvas, width, height)) {
      return null;
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Falha ao codificar imagem JPEG da página do PDF.'))),
        'image/jpeg',
        quality,
      );
    });
    return { blob, w: width, h: height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Converte um PDF (ArrayBuffer) em livro refluível (`ParsedBook`), ou em imagens se for escaneado ou apresentação.
 * Consome o `ArrayBuffer` diretamente (transferido ao Web Worker sem segunda cópia em memória).
 */
/** Tempo máximo para o pdf.js abrir o documento (xref e estrutura), sem contar a extração das páginas. */
const PDF_OPEN_TIMEOUT_MS = 60_000;

export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  onProgress: ProgressFn,
): Promise<ParsedBook> {
  onProgress(0, 'Abrindo PDF...');

  const browserBase =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined' && location.href
        ? location.href
        : undefined;
  const assetParams = browserBase && tryResolveBaseUrl(browserBase, './pdfjs/') ? getPdfAssetUrls(browserBase) : {};

  const bytes = new Uint8Array(data);
  const loadingTask = getDocument({
    data: bytes,
    ...assetParams,
    // Sem WebAssembly: o F-Droid não aceita os .wasm pré-compilados do pdf.js. JBIG2 e JPEG 2000
    // usam as versões em JavaScript; perfis de cor ICC (QCMS) caem no espaço de cor alternativo.
    useWasm: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_CANVAS_AREA * 4,
  });
  let doc: PdfDoc;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Se o motor do pdf.js não iniciar (worker que falha sem rejeitar), a importação não fica presa para sempre.
    const timeout = new Promise<never>((_, reject) => {
      openTimer = setTimeout(
        () => reject(new Error('O PDF não abriu: o leitor de PDF não iniciou neste aparelho.')),
        PDF_OPEN_TIMEOUT_MS,
      );
    });
    doc = await Promise.race([loadingTask.promise, timeout]);
  } catch (err) {
    clearTimeout(openTimer);
    try {
      await loadingTask.destroy();
    } catch {
      // Ignora falha ao liberar a tarefa.
    }
    throw friendlyPdfError(err);
  }
  clearTimeout(openTimer);

  try {
    const numPages = doc.numPages;
    if (numPages < 1) throw new Error('O PDF não tem páginas.');

    const images = new Map<string, Blob>();
    const warnings: string[] = [];
    const docLike = doc as unknown as PdfDocLike;

    // Metadados (título e autor).
    const info = await readPdfInfo(docLike);
    const title = info.title || titleFromFileName(fileName);
    const author = info.author;

    // Sumário do PDF (tem prioridade para títulos de capítulo).
    const outline = await extractOutline(docLike);

    // Leitura das páginas e geração da capa (página 1 no navegador).
    let cover: Blob | undefined;
    const pageInputs: PdfPageInput[] = [];
    const pageCharCounts: number[] = [];
    const pageCoverage: number[] = [];

    for (let i = 1; i <= numPages; i++) {
      onProgress((i - 1) / Math.max(1, numPages) * 0.85, `Lendo página ${i} de ${numPages}`);
      const page = await doc.getPage(i);
      try {
        if (i === 1 && canRenderCanvas()) {
          try {
            const renderedCover = await renderPageToJpeg(page, COVER_TARGET_WIDTH, COVER_JPEG_QUALITY);
            if (renderedCover) cover = renderedCover.blob;
          } catch {
            // Falha na capa não impede importação do livro.
          }
        }

        const pageLike = page as unknown as PdfPageLike;
        // A lista de operadores carrega as fontes (nome/negrito/itálico); precisa vir antes do texto.
        const coverage = await measurePageImageCoverage(pageLike, OPS);
        const { pageInput, charCount } = await extractPageText(pageLike, i);
        pageInputs.push(pageInput);
        pageCharCounts.push(charCount);
        pageCoverage.push(charCount >= 10 ? coverage : 0);
      } finally {
        page.cleanup();
      }
      if (i % DOC_CLEANUP_INTERVAL === 0 && i < numPages) {
        await cleanupDoc(doc);
      }
    }

    const stats: PageStat[] = pageInputs.map((p, idx) => ({
      width: p.width,
      height: p.height,
      chars: pageCharCounts[idx],
    }));
    const kind = classifyPdf(stats);

    if (kind === 'scanned') {
      warnings.push('PDF escaneado sem camada de texto: páginas convertidas em imagem.');
      const chapters: Chapter[] = [];

      if (canRenderCanvas()) {
        const blocksByChapter = new Map<number, Block[]>();
        let failedPages = 0;

        for (let i = 1; i <= numPages; i++) {
          onProgress(0.85 + ((i - 1) / Math.max(1, numPages)) * 0.14, `Renderizando página ${i} de ${numPages}`);
          let page: PdfPage | null = null;
          try {
            page = await doc.getPage(i);
            const rendered = await renderPageToJpeg(page, SCAN_TARGET_WIDTH, SCAN_JPEG_QUALITY);
            if (rendered) {
              const key = formatPageImageKey(i);
              images.set(key, rendered.blob);
              const chIdx = Math.floor((i - 1) / SCANNED_PAGES_PER_CHAPTER);
              let list = blocksByChapter.get(chIdx);
              if (!list) {
                list = [];
                blocksByChapter.set(chIdx, list);
              }
              list.push({
                t: 'img',
                src: key,
                alt: `Página ${i}`,
                w: rendered.w,
                h: rendered.h,
              });
            }
          } catch {
            failedPages++;
          } finally {
            page?.cleanup();
          }
          if (i % DOC_CLEANUP_INTERVAL === 0 && i < numPages) {
            await cleanupDoc(doc);
          }
        }

        if (failedPages > 0) {
          warnings.push(
            failedPages === 1
              ? 'Não foi possível renderizar 1 página escaneada.'
              : `Não foi possível renderizar ${failedPages} páginas escaneadas.`,
          );
        }

        const totalChapters = Math.ceil(numPages / SCANNED_PAGES_PER_CHAPTER);
        for (let chIdx = 0; chIdx < totalChapters; chIdx++) {
          const blocks = blocksByChapter.get(chIdx);
          if (!blocks || blocks.length === 0) continue;
          const start = chIdx * SCANNED_PAGES_PER_CHAPTER + 1;
          const end = Math.min(numPages, start + SCANNED_PAGES_PER_CHAPTER - 1);
          const chTitle = start === end ? `Página ${start}` : `Páginas ${start}–${end}`;
          chapters.push({ title: chTitle, blocks });
        }
      }

      onProgress(1, `Lendo página ${numPages} de ${numPages}`);
      return {
        title,
        ...(author ? { author } : {}),
        chapters,
        images,
        ...(cover ? { cover } : {}),
        fixedLayout: true,
        warnings,
      };
    }

    // Apresentação de slides: cada página vira imagem + texto (busca e leitura em letra grande).
    if (kind === 'slides') {
      const pageBlocks = extractPdfPageBlocks(pageInputs, { yOrigin: 'top-down' });
      const slides: SlideInput[] = [];
      for (let i = 0; i < pageBlocks.length; i++) {
        const pageNum = pageBlocks[i].pageNumber;
        onProgress(0.85 + (i / Math.max(1, numPages)) * 0.14, `Renderizando slide ${pageNum} de ${numPages}`);
        const slide: SlideInput = { pageNumber: pageNum, blocks: pageBlocks[i].blocks };
        if (canRenderCanvas()) {
          let page: PdfPage | null = null;
          try {
            page = await doc.getPage(pageNum);
            const rendered = await renderPageToJpeg(page, SLIDE_TARGET_WIDTH, SLIDE_JPEG_QUALITY);
            if (rendered) {
              const key = formatPageImageKey(pageNum);
              images.set(key, rendered.blob);
              slide.image = { src: key, w: rendered.w, h: rendered.h };
            }
          } catch {
            // Falha em um slide não impede a importação: fica só o texto dele.
          } finally {
            page?.cleanup();
          }
          if ((i + 1) % DOC_CLEANUP_INTERVAL === 0 && i + 1 < pageBlocks.length) {
            await cleanupDoc(doc);
          }
        }
        slides.push(slide);
      }

      onProgress(1, `Lendo página ${numPages} de ${numPages}`);
      return {
        title,
        ...(author ? { author } : {}),
        chapters: buildSlideChapters(slides),
        images,
        ...(cover ? { cover } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    // Páginas sem texto, ou de texto com figura pontual grande, ganham a imagem da página.
    // Quando quase todas as páginas de texto têm imagem inteira (camada OCR / fundo), não duplica em JPEG.
    if (canRenderCanvas()) {
      const textPageCoverages = pageCoverage.filter((_, idx) => pageCharCounts[idx] >= 10);
      const skipTextPageImages = hasFullPageImagePattern(textPageCoverages);
      const imagePageIndices: number[] = [];
      for (let i = 0; i < pageInputs.length; i++) {
        const noText = pageCharCounts[i] < 10;
        if (noText || (!skipTextPageImages && shouldRenderPageImage(pageCoverage[i]))) {
          imagePageIndices.push(i);
        }
      }

      for (let k = 0; k < imagePageIndices.length; k++) {
        const i = imagePageIndices[k];
        const noText = pageCharCounts[i] < 10;
        const pageNum = pageInputs[i].pageNumber;
        onProgress(
          0.85 + (k / Math.max(1, imagePageIndices.length)) * 0.1,
          `Renderizando imagem ${k + 1} de ${imagePageIndices.length}`,
        );
        let page: PdfPage | null = null;
        try {
          page = await doc.getPage(pageNum);
          const rendered = await renderPageToJpeg(page, SCAN_TARGET_WIDTH, SCAN_JPEG_QUALITY, noText);
          if (rendered) {
            const key = formatPageImageKey(pageNum);
            images.set(key, rendered.blob);
            pageInputs[i].fallbackImage = {
              src: key,
              w: rendered.w,
              h: rendered.h,
              alt: `Página ${pageNum}`,
            };
          }
        } catch {
          // Ignora falha ao renderizar página isolada.
        } finally {
          page?.cleanup();
        }
        if ((k + 1) % DOC_CLEANUP_INTERVAL === 0 && k + 1 < imagePageIndices.length) {
          await cleanupDoc(doc);
        }
      }
    }

    onProgress(0.95, 'Organizando capítulos...');
    const chapters = extractPdfChapters(pageInputs, {
      outline,
      yOrigin: 'top-down',
    });

    onProgress(1, `Lendo página ${numPages} de ${numPages}`);

    return {
      title,
      ...(author ? { author } : {}),
      chapters,
      images,
      ...(cover ? { cover } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    // Falhas ao ler páginas de um PDF danificado chegam como erros crus do pdf.js.
    throw friendlyPdfError(err);
  } finally {
    await loadingTask.destroy();
  }
}
