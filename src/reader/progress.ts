// Cálculos puros de progresso, paginação, tempo de leitura e trechos de marcadores.
import type { Block } from '../types';
import type { ReaderSettings } from '../settings';

export const WORDS_PER_MINUTE = 230;
export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 34;
export const MIN_LINE_HEIGHT = 1.2;
export const MAX_LINE_HEIGHT = 2.0;
export const MIN_MARGIN = 8;
export const MAX_MARGIN = 48;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampSettings(s: ReaderSettings): ReaderSettings {
  return {
    ...s,
    fontSize: Math.round(clamp(s.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)),
    lineHeight: Math.round(clamp(s.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT) * 100) / 100,
    margin: Math.round(clamp(s.margin, MIN_MARGIN, MAX_MARGIN)),
  };
}

/** Calcula o total de páginas de um capítulo em layout CSS multi-column. */
export function calcTotalPages(scrollWidth: number, pageWidth: number, gap: number): number {
  const step = pageWidth + gap;
  if (pageWidth <= 0 || step <= 0 || scrollWidth <= 0) return 1;
  return Math.max(1, Math.round((scrollWidth + gap) / step));
}

/** Mapeia o offsetLeft de um bloco para o índice da página (0-based). */
export function calcBlockPage(offsetLeft: number, step: number, totalPages: number): number {
  if (step <= 0 || totalPages <= 1) return 0;
  const page = Math.floor(Math.max(0, offsetLeft) / step);
  return clamp(page, 0, Math.max(1, Math.floor(totalPages)) - 1);
}

/** Percentual global do livro (0..100) usando chapterChars e a fração do capítulo atual. */
export function calcBookPercent(
  chapter: number,
  pageIndex: number,
  totalPages: number,
  chapterChars: readonly number[],
  totalChars: number,
): number {
  const chapterCount = chapterChars.length;
  if (chapterCount === 0) return 0;

  const safeChapter = clamp(Math.floor(chapter), 0, chapterCount - 1);
  const safeTotalPages = Math.max(1, Math.floor(totalPages));
  const safePage = clamp(Math.floor(pageIndex), 0, safeTotalPages - 1);

  if (safeChapter === chapterCount - 1 && safePage === safeTotalPages - 1) {
    return 100;
  }

  const chapterFraction = safePage / safeTotalPages;

  if (totalChars <= 0) {
    const raw = (safeChapter + chapterFraction) / chapterCount;
    return Math.round(clamp(raw, 0, 1) * 100);
  }

  let charsBefore = 0;
  for (let i = 0; i < safeChapter; i++) {
    charsBefore += Math.max(0, chapterChars[i] ?? 0);
  }
  const currentChars = Math.max(0, chapterChars[safeChapter] ?? 0);
  const raw = (charsBefore + currentChars * chapterFraction) / totalChars;
  return Math.round(clamp(raw, 0, 1) * 100);
}

/** Mapeia um percentual do livro (0..100) para capítulo destino e fração (0..1) dentro dele. */
export function percentToTarget(
  percent: number,
  chapterChars: readonly number[],
  totalChars: number,
): { chapter: number; fraction: number } {
  const chapterCount = chapterChars.length;
  if (chapterCount === 0) return { chapter: 0, fraction: 0 };

  const p = clamp(percent, 0, 100);
  if (p <= 0) return { chapter: 0, fraction: 0 };
  if (p >= 100) return { chapter: chapterCount - 1, fraction: 1 };

  if (totalChars <= 0) {
    const pos = (p / 100) * chapterCount;
    const ch = Math.min(chapterCount - 1, Math.floor(pos));
    return { chapter: ch, fraction: clamp(pos - ch, 0, 1) };
  }

  const targetChar = (p / 100) * totalChars;
  let acc = 0;
  for (let i = 0; i < chapterCount; i++) {
    const len = Math.max(0, chapterChars[i] ?? 0);
    if (len > 0 && targetChar < acc + len) {
      return { chapter: i, fraction: clamp((targetChar - acc) / len, 0, 1) };
    }
    acc += len;
  }

  return { chapter: chapterCount - 1, fraction: 1 };
}

/** Converte fração (0..1) dentro de um capítulo em índice de página (0-based). */
export function fractionToPage(fraction: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  if (safeTotal <= 1) return 0;
  const f = clamp(fraction, 0, 1);
  if (f >= 1) return safeTotal - 1;
  return clamp(Math.floor(f * safeTotal), 0, safeTotal - 1);
}

export function countBlockWords(block: Block): number {
  if (block.t === 'img' || block.t === 'hr') return 0;
  const trimmed = block.text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function countChapterWords(blocks: readonly Block[]): number {
  let words = 0;
  for (let i = 0; i < blocks.length; i++) {
    words += countBlockWords(blocks[i]);
  }
  return words;
}

/** Estima minutos restantes no capítulo a 230 palavras/min. Retorna 0 quando não há texto. */
export function estimateChapterMinutesLeft(
  totalWords: number,
  pageIndex: number,
  totalPages: number,
): number {
  if (totalWords <= 0) return 0;
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const safePage = clamp(Math.floor(pageIndex), 0, safeTotal - 1);
  const remainingFraction = (safeTotal - safePage) / safeTotal;
  const remainingWords = totalWords * remainingFraction;
  return Math.max(1, Math.round(remainingWords / WORDS_PER_MINUTE));
}

export function formatRemainingTime(minutes: number): string {
  if (minutes <= 0) return '';
  return minutes === 1 ? '1 min restante no capítulo' : `${minutes} min restantes no capítulo`;
}

/** Extrai um trecho legível para o marcador a partir do bloco inicial da página. */
export function extractExcerpt(
  blocks: readonly Block[],
  startBlock: number,
  fallback: string,
  maxLen = 84,
): string {
  const start = clamp(Math.floor(startBlock), 0, Math.max(0, blocks.length - 1));
  let text = '';

  for (let i = start; i < blocks.length && i < start + 6; i++) {
    const b = blocks[i];
    if (b.t === 'hr') continue;
    const candidate = b.t === 'img' ? (b.alt ?? '').trim() : b.text.replace(/\s+/g, ' ').trim();
    if (candidate) {
      text = candidate;
      break;
    }
  }

  const clean = (text || fallback).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.trimEnd()}…`;
}

/** Chave do localStorage com a última posição de leitura (rede de segurança contra o IndexedDB não gravar a tempo). */
export const positionStashKey = (bookId: string): string => `folha:pos:${bookId}`;

export interface PositionStash {
  chapter: number;
  block: number;
  percent: number;
  at: number;
}

export function readPositionStash(bookId: string): PositionStash | null {
  try {
    const raw = localStorage.getItem(positionStashKey(bookId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PositionStash>;
    if (
      typeof v.chapter === 'number' &&
      typeof v.block === 'number' &&
      typeof v.percent === 'number' &&
      typeof v.at === 'number'
    ) {
      return v as PositionStash;
    }
  } catch {
    // localStorage indisponível ou JSON inválido: ignora
  }
  return null;
}

export function writePositionStash(bookId: string, stash: PositionStash): void {
  try {
    localStorage.setItem(positionStashKey(bookId), JSON.stringify(stash));
  } catch {
    // Sem armazenamento disponível: a gravação normal no IndexedDB continua valendo
  }
}
