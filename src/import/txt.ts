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

/** Valida algarismo romano estritamente em maiúsculas (rejeita palavras comuns como "civil", "mil", "vi"). */
function isRomanNumeral(token: string): boolean {
  return (
    token.length > 0 &&
    token.length <= 10 &&
    /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(token)
  );
}

function isAllUpperHeading(trimmed: string): boolean {
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  // Diálogos gritados (— NÃO!, "SOCORRO!") e frases com pontuação final não são títulos de capítulo
  if (/^[—–\-"'“”«»]/.test(trimmed)) return false;
  if (/[,;.!?…"”'»]$/.test(trimmed)) return false;
  return trimmed === trimmed.toLocaleUpperCase('pt-BR') && trimmed !== trimmed.toLocaleLowerCase('pt-BR');
}

interface HeadingCheck {
  isHeading: boolean;
  explicit: boolean;
}

function classifyChapterHeading(trimmed: string, prevBlank: boolean, nextBlank: boolean): HeadingCheck {
  if (!trimmed || trimmed.length > 80) return { isHeading: false, explicit: false };
  if (/[,;]$/.test(trimmed)) return { isHeading: false, explicit: false };

  const capMatch = /^(?:cap[íi]tulo|chapter)\b(.*)$/i.exec(trimmed);
  if (capMatch) {
    if (trimmed.length <= 70 && prevBlank) {
      const rest = capMatch[1].trim();
      if (!rest) {
        if (nextBlank) return { isHeading: true, explicit: true };
      } else {
        const numOrRoman = /^(\d+|[A-Z]+)(?:$|\s*[:.\-–—]|\s+)/.exec(rest);
        if (numOrRoman) {
          const tok = numOrRoman[1];
          if (/^\d+$/.test(tok) || isRomanNumeral(tok)) {
            const afterTok = rest.slice(tok.length).trim();
            if (!afterTok || afterTok === '.') return { isHeading: true, explicit: true };
            if (/^[:.\-–—]/.test(afterTok) && !/[!?]$/.test(afterTok)) {
              return { isHeading: true, explicit: true };
            }
            if (nextBlank && !/[.!?]$/.test(afterTok)) {
              return { isHeading: true, explicit: true };
            }
          }
        }
        if (/^(?:[úu]nico|final)\b/i.test(rest) && !/[.!?]$/.test(rest)) {
          const afterKw = rest.replace(/^(?:[úu]nico|final)\b/i, '').trim();
          if (!afterKw || /^[:.\-–—]/.test(afterKw)) {
            if (nextBlank || rest.length <= 30) return { isHeading: true, explicit: true };
          }
        }
      }
    }
    if (prevBlank && nextBlank && isAllUpperHeading(trimmed)) {
      return { isHeading: true, explicit: false };
    }
    return { isHeading: false, explicit: false };
  }

  const secMatch =
    /^(?:pr[óo]logo|prologue|ep[íi]logo|epilogue|pref[áa]cio|preface|introdu[çc][ãa]o|introduction|ap[êe]ndice|appendix)\b(.*)$/i.exec(
      trimmed,
    );
  if (secMatch) {
    if (!prevBlank) return { isHeading: false, explicit: false };
    const rest = secMatch[1].trim();
    if (!rest) {
      return { isHeading: nextBlank || trimmed.length <= 20, explicit: true };
    }
    if (/^[:.\-–—]\s*\S/.test(rest) && !/[.!?]$/.test(rest) && (nextBlank || trimmed.length <= 50)) {
      return { isHeading: true, explicit: true };
    }
    if (/^(?:\d+|[A-Z]{1,4})(?:$|\s*[:.\-–—]\s*\S)/.test(rest) && !/[!?]$/.test(rest) && (nextBlank || trimmed.length <= 50)) {
      return { isHeading: true, explicit: true };
    }
    if (nextBlank && isAllUpperHeading(trimmed)) {
      return { isHeading: true, explicit: false };
    }
    return { isHeading: false, explicit: false };
  }

  const partMatch = /^(?:parte|part|livro|book|se[çc][ãa]o|section)\b(.*)$/i.exec(trimmed);
  if (partMatch) {
    if (!prevBlank) return { isHeading: false, explicit: false };
    const rest = partMatch[1].trim();
    if (!rest) {
      return { isHeading: nextBlank, explicit: nextBlank };
    }
    const tokMatch = /^(\d+|[A-Z]+)(?:$|\s*[:.\-–—]|\s+)/.exec(rest);
    if (tokMatch) {
      const tok = tokMatch[1];
      if (/^\d+$/.test(tok) || isRomanNumeral(tok)) {
        const afterTok = rest.slice(tok.length).trim();
        if (!afterTok || afterTok === '.') return { isHeading: true, explicit: true };
        if (/^[:.\-–—]/.test(afterTok) && !/[!?]$/.test(afterTok)) {
          return { isHeading: true, explicit: true };
        }
        if (nextBlank && !/[.!?]$/.test(afterTok)) {
          return { isHeading: true, explicit: true };
        }
      }
    }
    if (/^(?:[úu]nic[ao]|final)\b/i.test(rest) && !/[.!?]$/.test(rest)) {
      const afterKw = rest.replace(/^(?:[úu]nic[ao]|final)\b/i, '').trim();
      if ((!afterKw || /^[:.\-–—]/.test(afterKw)) && (nextBlank || isAllUpperHeading(trimmed))) {
        return { isHeading: true, explicit: true };
      }
    }
    if (nextBlank && isAllUpperHeading(trimmed)) {
      return { isHeading: true, explicit: false };
    }
    return { isHeading: false, explicit: false };
  }

  if (prevBlank && nextBlank && /^[IVXLCDM]+\.?$/.test(trimmed) && isRomanNumeral(trimmed.replace(/\.$/, ''))) {
    return { isHeading: true, explicit: true };
  }

  if (prevBlank && nextBlank && isAllUpperHeading(trimmed)) {
    return { isHeading: true, explicit: false };
  }

  return { isHeading: false, explicit: false };
}

function parseMarkdownHeading(trimmed: string): { level: 1 | 2 | 3; text: string } | null {
  const m = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/.exec(trimmed);
  if (!m) return null;
  const text = m[2].trim();
  if (!text) return null;
  return { level: m[1].length as 1 | 2 | 3, text };
}

interface TextEntry {
  text: string;
  isHeading: boolean;
  headingLevel?: 1 | 2 | 3;
  explicitHeading?: boolean;
}

function extractEntries(normalized: string, isMarkdown: boolean): TextEntry[] {
  const lines = normalized.split('\n');
  const reflow = isFixedWidthWrapped(lines);
  const entries: TextEntry[] = [];

  if (reflow) {
    let buf: string[] = [];
    let bufPrevBlank = true;
    let bufNextBlank = true;
    const flushBuf = () => {
      if (buf.length === 0) return;
      if (buf.length === 1) {
        const check = classifyChapterHeading(buf[0], bufPrevBlank, bufNextBlank);
        if (check.isHeading) {
          entries.push({ text: buf[0], isHeading: true, headingLevel: 1, explicitHeading: check.explicit });
          buf = [];
          return;
        }
      }
      entries.push({ text: buf.join(' '), isHeading: false });
      buf = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        flushBuf();
        continue;
      }
      if (isMarkdown) {
        const md = parseMarkdownHeading(trimmed);
        if (md) {
          flushBuf();
          entries.push({ text: md.text, isHeading: true, headingLevel: md.level, explicitHeading: true });
          continue;
        }
      }
      const prevBlank = i === 0 || lines[i - 1].trim() === '';
      const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
      if (buf.length === 0) {
        const check = classifyChapterHeading(trimmed, prevBlank, nextBlank);
        if (check.isHeading) {
          entries.push({ text: trimmed, isHeading: true, headingLevel: 1, explicitHeading: check.explicit });
          continue;
        }
        bufPrevBlank = prevBlank;
      }
      bufNextBlank = nextBlank;
      buf.push(trimmed);
    }
    flushBuf();
    return entries;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (isMarkdown) {
      const md = parseMarkdownHeading(trimmed);
      if (md) {
        entries.push({ text: md.text, isHeading: true, headingLevel: md.level, explicitHeading: true });
        continue;
      }
    }
    const prevBlank = i === 0 || lines[i - 1].trim() === '';
    const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
    const check = classifyChapterHeading(trimmed, prevBlank, nextBlank);
    entries.push({
      text: trimmed,
      isHeading: check.isHeading,
      ...(check.isHeading ? { headingLevel: 1 as const, explicitHeading: check.explicit } : {}),
    });
  }

  return entries;
}

function fallbackTitleFromFile(fileName: string): string {
  return fileName.replace(/\.(?:txt|md)$/i, '').trim() || 'Sem título';
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

/** Converte texto puro (TXT ou Markdown) em `ParsedBook`, com detecção de capítulos ou divisão por tamanho. */
export function parseTxt(text: string, fileName: string): ParsedBook {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const isMarkdown = /\.md$/i.test(fileName.trim());
  const entries = extractEntries(normalized, isMarkdown);

  const firstEntry = entries[0]?.text;
  const title = firstEntry && firstEntry.length <= 80 ? firstEntry : fallbackTitleFromFile(fileName);

  const hasChapters = entries.some((e) => e.isHeading);
  let chapters: Chapter[];

  if (hasChapters) {
    chapters = [];
    let currentTitle = title;
    let currentBlocks: Block[] = [];
    let hasBodySinceHeading = false;
    let currentHasExplicit = false;

    for (const entry of entries) {
      if (entry.isHeading) {
        // Folha de rosto curta (título, autor) antes do 1º capítulo vai junto dele, em vez de
        // virar um capítulo próprio de poucas palavras.
        const shortFrontMatter =
          chapters.length === 0 &&
          currentBlocks.every((b) => b.t === 'p') &&
          currentBlocks.reduce((n, b) => n + ('text' in b ? b.text.length : 0), 0) < 300;
        if (currentBlocks.length > 0 && hasBodySinceHeading && !shortFrontMatter) {
          chapters.push({ title: currentTitle, blocks: currentBlocks });
          currentBlocks = [];
          currentHasExplicit = false;
        }
        if (currentBlocks.length === 0 || !currentHasExplicit || entry.explicitHeading) {
          currentTitle = entry.text;
        }
        if (entry.explicitHeading) currentHasExplicit = true;
        currentBlocks.push({ t: 'h', level: entry.headingLevel ?? 1, text: entry.text });
        hasBodySinceHeading = false;
      } else {
        currentBlocks.push({ t: 'p', text: entry.text });
        hasBodySinceHeading = true;
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
