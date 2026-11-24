// Importador de PDF para ParsedBook usando pdfjs-dist com Web Worker.
// Carregado sob demanda via import dinâmico.
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
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
import { buildSlideChapters, classifyPdf, shouldRenderPageImage, type PageStat, type SlideInput } from './pdf-slides';

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

function canRenderCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
}

function formatPageImageKey(pageNumber: number): string {
  return `p${String(pageNumber).padStart(4, '0')}`;
}

/** Verifica rapidamente (amostragem em grade) se o canvas renderizado está praticamente todo branco. */
function isCanvasMostlyBlank(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  try {
    const sampleStepX = Math.max(1, Math.floor(width / 24));
    const sampleStepY = Math.max(1, Math.floor(height / 24));
    const data = ctx.getImageData(0, 0, width, height).data;
    let nonWhite = 0;
    for (let y = 0; y < height; y += sampleStepY) {
      for (let x = 0; x < width; x += sampleStepX) {
        const idx = (y * width + x) * 4;
        if (data[idx] < 245 || data[idx + 1] < 245 || data[idx + 2] < 245) {
          nonWhite++;
          if (nonWhite >= 4) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
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
  if (baseViewport.width <= 0 || baseViewport.height <= 0) return null;

  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    if (skipIfBlank && isCanvasMostlyBlank(ctx, width, height)) {
      canvas.width = 0;
      canvas.height = 0;
      return null;
    }

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    canvas.width = 0;
    canvas.height = 0;
    return { blob, w: width, h: height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
  }).promise;

  if (skipIfBlank && isCanvasMostlyBlank(ctx, width, height)) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Falha ao codificar imagem JPEG da página do PDF.'))),
      'image/jpeg',
      quality,
    );
  });
  canvas.width = 0;
  canvas.height = 0;
  return { blob, w: width, h: height };
}

/** Converte um PDF (ArrayBuffer) em livro refluível (`ParsedBook`), ou em imagens se for escaneado ou apresentação. */
export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  onProgress: ProgressFn,
): Promise<ParsedBook> {
  onProgress(0, 'Abrindo PDF...');

  const copy = new Uint8Array(data.slice(0));
  const loadingTask = getDocument({ data: copy });
  let doc: PdfDoc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    try {
      await loadingTask.destroy();
    } catch {
      // Ignora falha ao liberar a tarefa.
    }
    throw friendlyPdfError(err);
  }

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

        for (let i = 1; i <= numPages; i++) {
          onProgress(0.85 + ((i - 1) / Math.max(1, numPages)) * 0.14, `Renderizando página ${i} de ${numPages}`);
          const page = await doc.getPage(i);
          try {
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
          } finally {
            page.cleanup();
          }
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
          const page = await doc.getPage(pageNum);
          try {
            const rendered = await renderPageToJpeg(page, SLIDE_TARGET_WIDTH, SLIDE_JPEG_QUALITY);
            if (rendered) {
              const key = formatPageImageKey(pageNum);
              images.set(key, rendered.blob);
              slide.image = { src: key, w: rendered.w, h: rendered.h };
            }
          } catch {
            // Falha em um slide não impede a importação: fica só o texto dele.
          } finally {
            page.cleanup();
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

    // Páginas sem texto, ou de texto com figura grande, ganham a imagem da página.
    if (canRenderCanvas()) {
      for (let i = 0; i < pageInputs.length; i++) {
        const noText = pageCharCounts[i] < 10;
        if (!noText && !shouldRenderPageImage(pageCoverage[i])) continue;
        const pageNum = pageInputs[i].pageNumber;
        const page = await doc.getPage(pageNum);
        try {
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
          page.cleanup();
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
  } finally {
    await loadingTask.destroy();
  }
}
