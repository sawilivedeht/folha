import { coverKey, imageKey, saveBook } from '../db';
import type { Block, BookFormat, BookMeta, ParsedBook, ProgressFn } from '../types';

export interface FileInfo {
  fileName: string;
  format: BookFormat;
}

export interface ImportResult {
  id: string;
  warnings: string[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // PK\x03\x04

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function asciiSlice(bytes: Uint8Array, maxLen: number): string {
  const len = Math.min(bytes.length, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function stripExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/**
 * Detecta o formato do livro pela assinatura dos bytes (%PDF, PK + mimetype epub)
 * e, em segundo lugar, pela extensão do arquivo (.pdf, .epub, .txt, .md).
 */
export function detectFormat(bytes: Uint8Array, fileName: string): BookFormat | null {
  if (startsWithBytes(bytes, PDF_MAGIC)) {
    return 'pdf';
  }

  if (startsWithBytes(bytes, ZIP_MAGIC)) {
    const header = asciiSlice(bytes, 256);
    if (header.includes('mimetype') && header.includes('application/epub+zip')) {
      return 'epub';
    }
  }

  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'txt';

  return null;
}

function blockTextLength(block: Block): number {
  return block.t === 'img' || block.t === 'hr' ? 0 : block.text.length;
}

function hasUsableContent(parsed: ParsedBook): boolean {
  const hasText = parsed.chapters.some((ch) =>
    ch.blocks.some((b) => b.t !== 'img' && b.t !== 'hr' && b.text.trim().length > 0),
  );
  const hasImages =
    parsed.images.size > 0 || parsed.chapters.some((ch) => ch.blocks.some((b) => b.t === 'img'));
  return hasText || hasImages;
}

/** Monta o BookMeta inicial a partir do livro analisado e dos dados do arquivo. */
export function buildMeta(
  parsed: ParsedBook,
  fileInfo: FileInfo,
  id: string,
  now: number,
): BookMeta {
  const chapterChars = parsed.chapters.map((ch) =>
    ch.blocks.reduce((sum, b) => sum + blockTextLength(b), 0),
  );
  const totalChars = chapterChars.reduce((sum, n) => sum + n, 0);
  const chapterTitles = parsed.chapters.map((ch) => ch.title);

  const meta: BookMeta = {
    id,
    title: parsed.title.trim() || stripExtension(fileInfo.fileName),
    format: fileInfo.format,
    fileName: fileInfo.fileName,
    addedAt: now,
    hasCover: Boolean(parsed.cover),
    chapterChars,
    totalChars,
    chapterTitles,
    position: { chapter: 0, block: 0 },
    percent: 0,
    bookmarks: [],
  };

  if (parsed.author?.trim()) meta.author = parsed.author.trim();
  if (parsed.lang?.trim()) meta.lang = parsed.lang.trim();
  if (parsed.fixedLayout !== undefined) meta.fixedLayout = parsed.fixedLayout;

  return meta;
}

/**
 * Importa um arquivo (PDF, EPUB, TXT ou MD), salva no IndexedDB e retorna `{ id, warnings }`.
 */
export async function importFileWithWarnings(
  file: File,
  onProgress: ProgressFn,
): Promise<ImportResult> {
  onProgress(0, 'Lendo arquivo...');
  const buffer = await file.arrayBuffer();
  const headerBytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512));
  const format = detectFormat(headerBytes, file.name);

  if (!format) {
    throw new Error('Formato não suportado. Use arquivos PDF, EPUB, TXT ou MD.');
  }

  const subProgress: ProgressFn = (fraction, label) => {
    const clamped = Math.max(0, Math.min(1, fraction));
    onProgress(0.05 + clamped * 0.85, label);
  };

  let parsed: ParsedBook;
  if (format === 'pdf') {
    const { parsePdf } = await import('./pdf');
    parsed = await parsePdf(buffer, file.name, subProgress);
  } else if (format === 'epub') {
    const { parseEpub } = await import('./epub');
    parsed = await parseEpub(buffer, file.name, subProgress);
  } else {
    const { parseTxt, decodeText } = await import('./txt');
    subProgress(0.3, 'Decodificando texto...');
    const text = decodeText(buffer);
    subProgress(0.7, 'Organizando capítulos...');
    parsed = parseTxt(text, file.name);
  }

  if (!hasUsableContent(parsed)) {
    throw new Error('Não encontrei texto neste arquivo');
  }

  onProgress(0.92, 'Salvando na biblioteca...');
  const id = crypto.randomUUID();
  const meta = buildMeta(parsed, { fileName: file.name, format }, id, Date.now());

  const blobs = new Map<string, Blob>();
  for (const [localKey, blob] of parsed.images) {
    blobs.set(imageKey(id, localKey), blob);
  }
  if (parsed.cover) {
    blobs.set(coverKey(id), parsed.cover);
  }

  await saveBook(meta, { chapters: parsed.chapters }, blobs);
  onProgress(1, 'Importação concluída');

  return {
    id,
    warnings: parsed.warnings ?? [],
  };
}

/**
 * Importa um arquivo (PDF, EPUB, TXT ou MD), salva no IndexedDB e retorna o id do livro.
 */
export async function importFile(file: File, onProgress: ProgressFn): Promise<string> {
  const { id } = await importFileWithWarnings(file, onProgress);
  return id;
}
