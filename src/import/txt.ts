import type { Block, Chapter, ParsedBook } from '../types';

const MAX_CHUNK_CHARS = 40_000;

/** Decodifica bytes de texto detectando BOM UTF-8 / UTF-16 ou caindo de UTF-8 estrito para windows-1252. */
export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function isFixedWidthWrapped(lines: string[]): boolean {
  let hasBlankLine = false;
  const wrappedLengths: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      hasBlankLine = true;
      continue;
    }
    const nextTrimmed = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (nextTrimmed.length > 0) {
      wrappedLengths.push(trimmed.length);
    }
  }

  if (!hasBlankLine || wrappedLengths.length < 3) return false;

  let inFixedRange = 0;
  let overLong = 0;
  for (const len of wrappedLengths) {
    if (len >= 45 && len <= 85) inFixedRange++;
    if (len > 95) overLong++;
  }

  return inFixedRange / wrappedLengths.length >= 0.5 && overLong / wrappedLengths.length <= 0.1;
}

function isAllUpperHeading(trimmed: string): boolean {
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  if (/[,;]$/.test(trimmed)) return false;
  return trimmed === trimmed.toLocaleUpperCase('pt-BR') && trimmed !== trimmed.toLocaleLowerCase('pt-BR');
}

function isChapterHeading(trimmed: string, prevBlank: boolean, nextBlank: boolean): boolean {
  if (!trimmed || trimmed.length > 80) return false;
  if (/[,;]$/.test(trimmed)) return false;

  if (/^(?:cap[íi]tulo|chapter)\b/i.test(trimmed)) {
    return trimmed.length <= 70;
  }

  if (/^(?:pr[óo]logo|prologue|ep[íi]logo|epilogue|pref[áa]cio|preface|introdu[çc][ãa]o|introduction|ap[êe]ndice|appendix)\b/i.test(trimmed)) {
    return prevBlank || nextBlank || trimmed.length <= 40;
  }

  if (/^(?:parte|part|livro|book|se[çc][ãa]o|section)\b/i.test(trimmed)) {
    const hasNumberOrTitle = /^(?:parte|part|livro|book|se[çc][ãa]o|section)\s+(?:\d+|[IVXLCDM]+|[úu]nica)\b/i.test(trimmed);
    if (hasNumberOrTitle) return true;
    return (prevBlank && nextBlank && trimmed.length <= 40) || isAllUpperHeading(trimmed);
  }

  if (prevBlank && nextBlank && /^[IVXLCDM]+\.?$/.test(trimmed) && trimmed.length <= 10) {
    return true;
  }

  if (prevBlank && nextBlank && isAllUpperHeading(trimmed)) {
    return true;
  }

  return false;
}

interface TextEntry {
  text: string;
  isHeading: boolean;
}

function extractEntries(normalized: string): TextEntry[] {
  const lines = normalized.split('\n');
  const reflow = isFixedWidthWrapped(lines);
  const entries: TextEntry[] = [];

  if (reflow) {
    let buf: string[] = [];
    const flushBuf = () => {
      if (buf.length === 0) return;
      if (buf.length === 1 && isChapterHeading(buf[0], true, true)) {
        entries.push({ text: buf[0], isHeading: true });
      } else {
        entries.push({ text: buf.join(' '), isHeading: false });
      }
      buf = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        flushBuf();
        continue;
      }
      const prevBlank = i === 0 || lines[i - 1].trim() === '';
      const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
      if (buf.length === 0 && isChapterHeading(trimmed, prevBlank, nextBlank)) {
        entries.push({ text: trimmed, isHeading: true });
      } else {
        buf.push(trimmed);
      }
    }
    flushBuf();
    return entries;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const prevBlank = i === 0 || lines[i - 1].trim() === '';
    const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
    entries.push({
      text: trimmed,
      isHeading: isChapterHeading(trimmed, prevBlank, nextBlank),
    });
  }

  return entries;
}

function fallbackTitleFromFile(fileName: string): string {
  return fileName.replace(/\.txt$/i, '').trim() || 'Sem título';
}

function splitBySize(blocks: Block[]): Chapter[] {
  if (blocks.length === 0) return [];
  const chapters: Chapter[] = [];
  let current: Block[] = [];
  let charCount = 0;

  for (const block of blocks) {
    const len = block.t === 'hr' || block.t === 'img' ? 0 : block.text.length;
    if (current.length > 0 && charCount + len > MAX_CHUNK_CHARS) {
      chapters.push({ title: `Parte ${chapters.length + 1}`, blocks: current });
      current = [];
      charCount = 0;
    }
    current.push(block);
    charCount += len;
  }

  if (current.length > 0) {
    chapters.push({ title: `Parte ${chapters.length + 1}`, blocks: current });
  }
  return chapters;
}

/** Converte texto puro (TXT) em `ParsedBook`, com detecção de capítulos ou divisão por tamanho. */
export function parseTxt(text: string, fileName: string): ParsedBook {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const entries = extractEntries(normalized);

  const firstEntry = entries[0]?.text;
  const title = firstEntry && firstEntry.length <= 80 ? firstEntry : fallbackTitleFromFile(fileName);

  const hasChapters = entries.some((e) => e.isHeading);
  let chapters: Chapter[];

  if (hasChapters) {
    chapters = [];
    let currentTitle = title;
    let currentBlocks: Block[] = [];

    for (const entry of entries) {
      if (entry.isHeading) {
        if (currentBlocks.length > 0) {
          chapters.push({ title: currentTitle, blocks: currentBlocks });
          currentBlocks = [];
        }
        currentTitle = entry.text;
        currentBlocks.push({ t: 'h', level: 1, text: entry.text });
      } else {
        currentBlocks.push({ t: 'p', text: entry.text });
      }
    }
    if (currentBlocks.length > 0) {
      chapters.push({ title: currentTitle, blocks: currentBlocks });
    }
  } else {
    const blocks: Block[] = entries.map((e) => ({ t: 'p', text: e.text }));
    chapters = splitBySize(blocks);
  }

  return {
    title,
    chapters,
    images: new Map<string, Blob>(),
  };
}
