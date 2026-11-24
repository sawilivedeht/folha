// Executa no Node o mesmo caminho de extração do CLI/navegador (sem renderização de imagens).
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Block, Chapter } from '../../src/types';
import {
  extractOutline,
  extractPageText,
  friendlyPdfError,
  measurePageImageCoverage,
  readPdfInfo,
  type PdfDocLike,
  type PdfPageLike,
} from '../../src/import/pdf-extract';
import { extractPdfChapters, extractPdfPageBlocks, type PdfPageInput } from '../../src/import/pdf-layout';
import { buildSlideChapters, classifyPdf, type PageStat, type PdfKind } from '../../src/import/pdf-slides';

export interface NodePdfResult {
  title: string;
  numPages: number;
  chapters: Chapter[];
  kind: PdfKind;
  slideDeck: boolean;
  stats: PageStat[];
  coverage: number[];
  pages: PdfPageInput[];
}

export async function convertPdfBytes(bytes: Uint8Array): Promise<NodePdfResult> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw friendlyPdfError(err);
  }
  try {
    if (doc.numPages < 1) throw new Error('O PDF não tem páginas.');
    const docLike = doc as unknown as PdfDocLike;
    const info = await readPdfInfo(docLike);
    const outline = await extractOutline(docLike);
    const pages: PdfPageInput[] = [];
    const stats: PageStat[] = [];
    const coverage: number[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const like = page as unknown as PdfPageLike;
      const pageCoverage = await measurePageImageCoverage(like, OPS);
      const { pageInput, charCount } = await extractPageText(like, i);
      stats.push({ width: pageInput.width, height: pageInput.height, chars: charCount });
      coverage.push(pageCoverage);
      pages.push(pageInput);
      page.cleanup();
    }
    const kind = classifyPdf(stats);
    const slideDeck = kind === 'slides';
    let chapters: Chapter[];
    if (slideDeck) {
      const slides = extractPdfPageBlocks(pages, { yOrigin: 'top-down' }).map((p, idx) => ({
        pageNumber: p.pageNumber,
        blocks: p.blocks,
        image: { src: `p${String(p.pageNumber).padStart(4, '0')}`, w: 1280, h: 720 },
      }));
      chapters = buildSlideChapters(slides);
    } else if (kind === 'scanned') {
      chapters = [];
    } else {
      chapters = extractPdfChapters(pages, { outline, yOrigin: 'top-down' });
    }
    return { title: info.title, numPages: doc.numPages, chapters, kind, slideDeck, stats, coverage, pages };
  } finally {
    await task.destroy();
  }
}

export function allBlocks(chapters: Chapter[]): Block[] {
  return chapters.flatMap((c) => c.blocks);
}

export function allText(chapters: Chapter[]): string {
  return allBlocks(chapters)
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
}
