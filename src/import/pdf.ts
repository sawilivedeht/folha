// Importador de PDF para ParsedBook usando pdfjs-dist com Web Worker.
// Carregado sob demanda via import dinâmico.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Block, Chapter, ParsedBook, ProgressFn } from '../types';
import {
  extractPdfChapters,
  type PdfOutlineEntry,
  type PdfPageInput,
  type PdfTextItem,
} from './pdf-layout';

if (typeof workerUrl === 'string' && workerUrl.length > 0) {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

type PdfDoc = Awaited<ReturnType<typeof getDocument>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>;

const COVER_TARGET_WIDTH = 360;
const COVER_JPEG_QUALITY = 0.8;
const SCAN_TARGET_WIDTH = 1200;
const SCAN_JPEG_QUALITY = 0.75;
const SCANNED_CHARS_THRESHOLD = 40;
const SCANNED_RATIO_THRESHOLD = 0.7;
const SCANNED_PAGES_PER_CHAPTER = 20;

interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineNode[];
}

function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Sem título';
}

function canRenderCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
}

function formatPageImageKey(pageNumber: number): string {
  return `p${String(pageNumber).padStart(4, '0')}`;
}

function resolveFontName(
  page: PdfPage,
  fontName: string,
  styles: Record<string, { fontFamily?: string } | undefined>,
): string {
  try {
    if (page.commonObjs && typeof page.commonObjs.has === 'function' && page.commonObjs.has(fontName)) {
      const obj = page.commonObjs.get(fontName) as { name?: string } | undefined;
      if (obj && typeof obj.name === 'string' && obj.name.length > 0) {
        return obj.name;
      }
    }
  } catch {
    // Fonte ainda não resolvida em commonObjs; usa o nome disponível.
  }
  const family = styles[fontName]?.fontFamily;
  return family ? `${fontName} ${family}` : fontName;
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

/** Resolve o destino de um item do sumário para o número de página (1-based). */
async function resolveDestPageNumber(doc: PdfDoc, dest: string | unknown[] | null): Promise<number | null> {
  if (!dest) return null;
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    if (typeof ref === 'number') return ref + 1;
    if (ref && typeof ref === 'object') {
      const idx = await doc.getPageIndex(ref as Parameters<PdfDoc['getPageIndex']>[0]);
      return idx + 1;
    }
  } catch {
    // Destino inválido ou não resolvível no PDF.
  }
  return null;
}

async function extractOutline(doc: PdfDoc): Promise<PdfOutlineEntry[]> {
  let rawOutline: RawOutlineNode[] | null = null;
  try {
    rawOutline = (await doc.getOutline()) as RawOutlineNode[] | null;
  } catch {
    return [];
  }
  if (!rawOutline || rawOutline.length === 0) return [];

  const entries: PdfOutlineEntry[] = [];
  const walk = async (nodes: RawOutlineNode[], level: number) => {
    for (const node of nodes) {
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (title.length > 0) {
        const pageNumber = await resolveDestPageNumber(doc, node.dest);
        if (pageNumber !== null && pageNumber >= 1 && pageNumber <= doc.numPages) {
          entries.push({ title, pageNumber, level });
        }
      }
      if (Array.isArray(node.items) && node.items.length > 0) {
        await walk(node.items, level + 1);
      }
    }
  };

  await walk(rawOutline, 0);
  return entries;
}

/** Extrai itens de texto em coordenadas top-down usando a matriz do viewport (trata rotação e CropBox). */
async function extractPageText(page: PdfPage, pageNumber: number): Promise<{ pageInput: PdfPageInput; charCount: number }> {
  const viewport = page.getViewport({ scale: 1 });
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string } | undefined>;

  const items: PdfTextItem[] = [];
  let charCount = 0;

  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const str = raw.str;
    if (!str) continue;

    const [, , tc, td, te, tf] = raw.transform;
    const x = va * te + vc * tf + ve;
    const y = vb * te + vd * tf + vf;
    const m2 = va * tc + vc * td;
    const m3 = vb * tc + vd * td;
    const h = Math.hypot(m2, m3) || Math.abs(raw.height) || 12;
    const w = Math.abs(raw.width);

    charCount += str.replace(/\s+/g, '').length;

    items.push({
      str,
      x,
      y,
      w,
      h,
      fontName: resolveFontName(page, raw.fontName, styles),
    });
  }

  return {
    pageInput: {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
    },
    charCount,
  };
}

/** Converte um PDF (ArrayBuffer) em livro refluível (`ParsedBook`), ou em imagens se for escaneado. */
export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  onProgress: ProgressFn,
): Promise<ParsedBook> {
  onProgress(0, 'Abrindo PDF...');

  const copy = new Uint8Array(data.slice(0));
  const loadingTask = getDocument({ data: copy });
  const doc = await loadingTask.promise;

  try {
    const numPages = doc.numPages;
    const images = new Map<string, Blob>();
    const warnings: string[] = [];

    // Metadados (título e autor).
    let title = '';
    let author = '';
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      if (typeof info.Title === 'string') title = info.Title.trim();
      if (typeof info.Author === 'string') author = info.Author.trim();
    } catch {
      // Metadados ausentes ou corrompidos; usa nome do arquivo.
    }
    if (!title) title = titleFromFileName(fileName);

    // Sumário do PDF (tem prioridade para títulos de capítulo).
    const outline = await extractOutline(doc);

    // Leitura das páginas e geração da capa (página 1 no navegador).
    let cover: Blob | undefined;
    const pageInputs: PdfPageInput[] = [];
    const pageCharCounts: number[] = [];

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

        const { pageInput, charCount } = await extractPageText(page, i);
        pageInputs.push(pageInput);
        pageCharCounts.push(charCount);
      } finally {
        page.cleanup();
      }
    }

    // Verifica se é PDF escaneado (< 40 caracteres em > 70% das páginas).
    const lowTextPages = pageCharCounts.filter((c) => c < SCANNED_CHARS_THRESHOLD).length;
    const isScanned = numPages > 0 && lowTextPages / numPages > SCANNED_RATIO_THRESHOLD;

    if (isScanned) {
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

    // Páginas isoladas sem texto num PDF com texto (ex.: figura de página inteira) viram bloco img.
    if (canRenderCanvas()) {
      for (let i = 0; i < pageInputs.length; i++) {
        if (pageCharCounts[i] >= 10) continue;
        const pageNum = pageInputs[i].pageNumber;
        const page = await doc.getPage(pageNum);
        try {
          const rendered = await renderPageToJpeg(page, SCAN_TARGET_WIDTH, SCAN_JPEG_QUALITY, true);
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
