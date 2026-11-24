// Lógica pura do modo "apresentação": decide se um PDF é um deck de slides e monta os blocos.
// Sem dependências de pdfjs-dist ou DOM. Compatível com `node --experimental-strip-types`.
import type { Block, Chapter } from '../types';

/** Mediana de caracteres por página abaixo da qual o PDF é tratado como apresentação. */
export const SLIDE_MEDIAN_CHARS = 400;
/** Fração mínima de páginas em paisagem para considerar o formato de slide. */
export const SLIDE_LANDSCAPE_RATIO = 0.7;
/** Com páginas em paisagem, aceita medianas maiores (até este valor). */
export const SLIDE_LANDSCAPE_MEDIAN_CHARS = 1200;
/** Fração da página coberta por imagem a partir da qual a página também ganha o bloco `img`. */
export const IMAGE_COVERAGE_THRESHOLD = 0.4;
export const SLIDES_PER_CHAPTER = 10;

export interface PageStat {
  width: number;
  height: number;
  /** Caracteres de texto (sem espaços) da página. */
  chars: number;
}

/** Páginas com menos caracteres que isto contam como "sem texto" para detectar PDF escaneado. */
export const SCANNED_CHARS_THRESHOLD = 40;
/** Fração de páginas sem texto acima da qual o PDF é tratado como escaneado. */
export const SCANNED_RATIO_THRESHOLD = 0.7;

export type PdfKind = 'scanned' | 'slides' | 'text';

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Decide se o PDF é uma apresentação: páginas com pouco texto, ou em paisagem com texto moderado. */
export function isSlideDeck(stats: PageStat[]): boolean {
  if (stats.length < 2) return false;
  const med = median(stats.map((s) => s.chars));
  const landscape = stats.filter((s) => s.width > s.height * 1.2).length / stats.length;
  if (med < SLIDE_MEDIAN_CHARS) return true;
  return landscape >= SLIDE_LANDSCAPE_RATIO && med < SLIDE_LANDSCAPE_MEDIAN_CHARS;
}

/** Página de texto com figura grande: também deve ganhar o bloco `img` da página. */
export function shouldRenderPageImage(imageCoverage: number): boolean {
  return imageCoverage > IMAGE_COVERAGE_THRESHOLD;
}

export interface SlideInput {
  pageNumber: number;
  /** Blocos de texto da página (já limpos pelo layout). */
  blocks: Block[];
  /** Imagem renderizada da página (ausente quando não foi possível renderizar). */
  image?: { src: string; w: number; h: number };
}

function blockText(b: Block): string {
  return 'text' in b ? b.text : '';
}

/** Título de um slide: primeiro texto não vazio, cortado em ~80 caracteres. */
export function slideTitle(slide: SlideInput): string {
  for (const b of slide.blocks) {
    const t = blockText(b).replace(/\s+/g, ' ').trim();
    if (t) return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
  }
  return `Slide ${slide.pageNumber}`;
}

/** Blocos de um slide: a imagem da página seguida do texto como parágrafos (títulos viram parágrafos). */
export function slideBlocks(slide: SlideInput): Block[] {
  const out: Block[] = [];
  if (slide.image) {
    out.push({ t: 'img', src: slide.image.src, alt: `Slide ${slide.pageNumber}`, w: slide.image.w, h: slide.image.h });
  }
  for (const b of slide.blocks) {
    if (b.t === 'h') out.push({ t: 'p', text: b.text, runs: [{ s: b.text, b: 1 }] });
    else if (b.t !== 'img') out.push(b);
    else if (!slide.image) out.push(b);
  }
  return out;
}

/** Agrupa slides em capítulos de `perChapter`, titulados pelo primeiro slide do grupo. */
export function buildSlideChapters(slides: SlideInput[], perChapter: number = SLIDES_PER_CHAPTER): Chapter[] {
  const chapters: Chapter[] = [];
  for (let i = 0; i < slides.length; i += perChapter) {
    const group = slides.slice(i, i + perChapter);
    const blocks: Block[] = [];
    for (const s of group) blocks.push(...slideBlocks(s));
    if (blocks.length === 0) continue;
    const first = group.find((s) => s.blocks.length > 0) ?? group[0];
    chapters.push({ title: slideTitle(first), blocks });
  }
  return chapters;
}

/** PDF escaneado: mais de 70% das páginas com menos de 40 caracteres. */
export function isScannedPdf(stats: PageStat[]): boolean {
  if (stats.length === 0) return false;
  const low = stats.filter((s) => s.chars < SCANNED_CHARS_THRESHOLD).length;
  return low / stats.length > SCANNED_RATIO_THRESHOLD;
}

/** Decisão pura do tipo de PDF: escaneado (fixedLayout) > apresentação (imagem + texto) > texto refluível. */
export function classifyPdf(stats: PageStat[]): PdfKind {
  if (isScannedPdf(stats)) return 'scanned';
  if (isSlideDeck(stats)) return 'slides';
  return 'text';
}
