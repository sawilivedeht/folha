// Algoritmo puro de reconstrução de layout de PDF para blocos refluíveis.
// Sem dependências de pdfjs-dist ou DOM — executável diretamente no Node e em testes vitest.
// Mantém apenas sintaxe TypeScript apagável (compatível com `node --experimental-strip-types`).
import type { Block, Chapter, Run } from '../types';

export interface PdfTextItem {
  str: string;
  x: number;
  /** Coordenada Y: por padrão em espaço PDF (origem embaixo, cresce para cima). Use yOrigin: 'top-down' se Y cresce para baixo. */
  y: number;
  w: number;
  /** Altura da fonte (em pontos/px na mesma escala de width/height). */
  h: number;
  fontName: string;
  bold?: boolean;
  italic?: boolean;
}

export interface PdfPageInput {
  /** Número da página (1-based). */
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  /** Imagem de página inteira para páginas isoladas sem texto (ex.: figura/mapa). */
  fallbackImage?: { src: string; w: number; h: number; alt?: string };
}

export interface PdfOutlineEntry {
  title: string;
  /** Página de destino (1-based). */
  pageNumber: number;
  /** Nível no sumário (0 = raiz). */
  level?: number;
}

export interface PdfLayoutOptions {
  /** Sumário do PDF; tem prioridade sobre títulos detectados para cortar capítulos. */
  outline?: PdfOutlineEntry[];
  /** Limite aproximado de caracteres por capítulo antes de dividir em "(cont.)". Padrão: 60000. */
  maxChapterChars?: number;
  /** Páginas por capítulo quando não há títulos nem sumário. Padrão: 15. */
  pagesPerChapter?: number;
  /** Origem do eixo Y dos itens. Padrão: 'pdf' (cresce para cima). */
  yOrigin?: 'pdf' | 'top-down';
}

interface NormItem {
  str: string;
  rawWhitespaceOnly: boolean;
  x: number;
  yTop: number;
  w: number;
  h: number;
  bold: boolean;
  italic: boolean;
}

interface TextSpan {
  s: string;
  b?: 1;
  i?: 1;
  sup?: 1;
}

interface LayoutLine {
  pageNumber: number;
  pageHeight: number;
  text: string;
  spans: TextSpan[];
  x: number;
  xEnd: number;
  yTop: number;
  fontSize: number;
  allBold: boolean;
  allItalic: boolean;
  colLeft: number;
  colRight: number;
  column: number; // 0 = largura total, 1 = coluna esquerda, 2 = coluna direita
}

interface TaggedBlock {
  block: Block;
  pageNumber: number;
}

const DEFAULT_MAX_CHAPTER_CHARS = 60_000;
const DEFAULT_PAGES_PER_CHAPTER = 15;
const MAX_HEADING_LENGTH = 120;

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

const LIGATURE_RE = /[\uFB00-\uFB06]/g;
const WEIRD_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\r\n]+/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
// Remove caracteres de controle mantendo \u00AD (soft hyphen) até a etapa de desifenização.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const BOLD_FONT_RE = /(?:bold|black|heavy|semibold|demibold|extrabold|ultrabold|(?:^|[-_+])(?:bd|demi)(?:$|[-_+]|mt|it|ob)|^cmbx)/i;
const ITALIC_FONT_RE = /(?:italic|oblique|slant|(?:^|[-_+])(?:it|ob|ital)(?:$|[-_+]|mt)|^cm(?:ti|sl))/i;

// Prefixos portugueses (e compostos clássicos) que sempre mantêm hífen segundo o Acordo Ortográfico.
const ALWAYS_HYPHEN_PREFIXES = new Set([
  'ex',
  'vice',
  'pré',
  'pós',
  'pró',
  'recém',
  'além',
  'aquém',
  'grão',
  'grã',
  'soto',
  'sota',
  'bem',
  'mal',
  'sem',
  'beija',
  'couve',
  'arco',
  'quebra',
  'saca',
  'tira',
  'bate',
  'pica',
  'vira',
]);

// Prefixos que mantêm hífen apenas antes de 'h' ou da mesma vogal final.
const SAME_VOWEL_OR_H_PREFIXES = new Set([
  'anti',
  'auto',
  'contra',
  'extra',
  'infra',
  'intra',
  'macro',
  'micro',
  'mini',
  'neo',
  'proto',
  'pseudo',
  'semi',
  'sobre',
  'supra',
  'ultra',
]);

// Prefixos terminados em 'r' que mantêm hífen antes de 'r' ou 'h'.
const R_OR_H_PREFIXES = new Set(['inter', 'hiper', 'super']);

// Pares compostos frequentes em português (prefixo -> sufixos conhecidos).
const KNOWN_COMPOUND_PAIRS: Record<string, Set<string>> = {
  segunda: new Set(['feira', 'feiras']),
  terça: new Set(['feira', 'feiras']),
  quarta: new Set(['feira', 'feiras']),
  quinta: new Set(['feira', 'feiras']),
  sexta: new Set(['feira', 'feiras']),
  guarda: new Set([
    'chuva',
    'chuvas',
    'roupa',
    'roupas',
    'sol',
    'costas',
    'livros',
    'noturno',
    'pó',
    'vidas',
    'mato',
    'florestal',
  ]),
  porta: new Set([
    'voz',
    'vozes',
    'aviões',
    'bandeira',
    'malas',
    'retrato',
    'retratos',
    'luvas',
    'chaves',
    'joias',
    'jóias',
  ]),
  matéria: new Set(['prima', 'primas']),
  obra: new Set(['prima', 'primas']),
  meio: new Set(['dia', 'fio', 'termo']),
  meia: new Set(['noite', 'luz', 'volta', 'idade', 'entrada']),
  alto: new Set(['falante', 'falantes', 'mar', 'relevo']),
  curto: new Set(['circuito', 'circuitos']),
  primeiro: new Set(['ministro', 'ministros']),
  primeira: new Set(['ministra', 'dama', 'mão']),
  salário: new Set(['mínimo', 'família']),
  seguro: new Set(['desemprego', 'saúde', 'vida']),
  mão: new Set(['dupla', 'única', 'cheia']),
  ponto: new Set(['final', 'chave', 'morto']),
  livre: new Set(['arbítrio', 'docente', 'pensador', 'comércio']),
  longa: new Set(['metragem', 'metragens']),
  curta: new Set(['metragem', 'metragens']),
  recém: new Set(['nascido', 'nascidos', 'casado', 'casados', 'chegado', 'formado']),
};

const CLITIC_LO_SET = new Set(['lo', 'la', 'los', 'las']);
const CLITIC_LHE_SET = new Set(['lhe', 'lhes']);
const CLITIC_SE_SET = new Set(['se', 'me', 'te', 'nos', 'vos']);

/** Normaliza ligaduras, espaços estranhos e caracteres de controle. */
export function normalizePdfText(str: string): string {
  return str
    .replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch)
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_CHAR_RE, '')
    .replace(WEIRD_SPACE_RE, ' ');
}

function stripSoftHyphens(str: string): string {
  return str.replace(/\u00AD/g, '');
}

function detectBold(item: PdfTextItem): boolean {
  if (typeof item.bold === 'boolean') return item.bold;
  return BOLD_FONT_RE.test(item.fontName);
}

function detectItalic(item: PdfTextItem): boolean {
  if (typeof item.italic === 'boolean') return item.italic;
  return ITALIC_FONT_RE.test(item.fontName);
}

function weightedMedian(entries: Array<{ value: number; weight: number }>, fallback: number): number {
  if (entries.length === 0) return fallback;
  const sorted = entries.slice().sort((a, b) => a.value - b.value);
  let total = 0;
  for (const e of sorted) total += e.weight;
  if (total <= 0) return fallback;
  const half = total / 2;
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= half) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number, fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/** Converte os itens da página para coordenadas top-down normalizadas. */
function normalizePageItems(page: PdfPageInput, yOrigin: 'pdf' | 'top-down'): NormItem[] {
  const out: NormItem[] = [];
  for (const raw of page.items) {
    const str = normalizePdfText(raw.str);
    if (str.length === 0) continue;
    const rawWhitespaceOnly = str.trim().length === 0;
    const h = raw.h > 0 ? raw.h : 12;
    const w = Math.max(0, raw.w);
    const yTop = yOrigin === 'top-down' ? raw.y : page.height - raw.y;
    out.push({
      str,
      rawWhitespaceOnly,
      x: raw.x,
      yTop,
      w,
      h,
      bold: detectBold(raw),
      italic: detectItalic(raw),
    });
  }
  return out;
}

interface RawRow {
  yTop: number;
  maxH: number;
  items: NormItem[];
}

/** Agrupa itens por linha de base (mesmo yTop dentro de tolerância). */
function groupIntoRawRows(items: NormItem[]): RawRow[] {
  if (items.length === 0) return [];
  const sorted = items.slice().sort((a, b) => a.yTop - b.yTop || a.x - b.x);
  const rows: RawRow[] = [];

  for (const item of sorted) {
    let matched: RawRow | null = null;
    let bestDist = Infinity;
    // Busca nas últimas linhas criadas para lidar com pequenas variações de yTop.
    const startIdx = Math.max(0, rows.length - 6);
    for (let i = rows.length - 1; i >= startIdx; i--) {
      const row = rows[i];
      const tol = Math.max(2, Math.max(row.maxH, item.h) * 0.42);
      const dist = Math.abs(item.yTop - row.yTop);
      if (dist <= tol && dist < bestDist) {
        bestDist = dist;
        matched = row;
      }
    }

    if (matched) {
      matched.items.push(item);
      if (item.h > matched.maxH) matched.maxH = item.h;
      // Mantém yTop ponderado pelos itens não-sobrescritos.
      if (item.h >= matched.maxH * 0.75) {
        const n = matched.items.length;
        matched.yTop = (matched.yTop * (n - 1) + item.yTop) / n;
      }
    } else {
      rows.push({ yTop: item.yTop, maxH: item.h, items: [item] });
    }
  }

  rows.sort((a, b) => a.yTop - b.yTop);
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
  }
  return rows;
}

function coalesceSpans(spans: TextSpan[]): TextSpan[] {
  const merged: TextSpan[] = [];
  for (const span of spans) {
    if (span.s.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.b === span.b && prev.i === span.i && prev.sup === span.sup) {
      prev.s += span.s;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function trimSpans(spans: TextSpan[]): TextSpan[] {
  const out = coalesceSpans(spans);
  while (out.length > 0) {
    out[0].s = out[0].s.replace(/^ +/, '');
    if (out[0].s.length === 0) out.shift();
    else break;
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    last.s = last.s.replace(/ +$/, '');
    if (last.s.length === 0) out.pop();
    else break;
  }
  return out;
}

/** Constrói uma LayoutLine a partir de itens ordenados em X na mesma linha. */
function buildLayoutLine(
  items: NormItem[],
  pageNumber: number,
  pageHeight: number,
  colLeft: number,
  colRight: number,
  column: number,
): LayoutLine | null {
  if (items.length === 0) return null;
  const sorted = items.slice().sort((a, b) => a.x - b.x);

  // Calcula tamanho de fonte dominante na linha.
  const sizeWeights: Array<{ value: number; weight: number }> = [];
  let sumY = 0;
  let countY = 0;
  for (const it of sorted) {
    if (it.rawWhitespaceOnly) continue;
    const len = it.str.trim().length;
    if (len > 0) {
      sizeWeights.push({ value: Math.round(it.h * 2) / 2, weight: len });
    }
  }
  if (sizeWeights.length === 0) return null;

  const lineFontSize = weightedMedian(sizeWeights, sorted[0].h);
  for (const it of sorted) {
    if (!it.rawWhitespaceOnly && it.h >= lineFontSize * 0.75) {
      sumY += it.yTop;
      countY++;
    }
  }
  const baseY = countY > 0 ? sumY / countY : sorted[0].yTop;

  const spans: TextSpan[] = [];
  let prevVisible: NormItem | null = null;
  let pendingSpace = false;
  let firstX = Infinity;
  let lastXEnd = -Infinity;
  let totalNonSpaceChars = 0;
  let boldChars = 0;
  let italicChars = 0;

  for (const it of sorted) {
    if (it.rawWhitespaceOnly) {
      if (prevVisible) pendingSpace = true;
      continue;
    }

    // Deduplica "fake bold" por sobreimpressão idêntica na mesma posição.
    if (
      prevVisible &&
      it.str === prevVisible.str &&
      Math.abs(it.x - prevVisible.x) < 1.5 &&
      Math.abs(it.yTop - prevVisible.yTop) < 1.5
    ) {
      const lastSpan = spans[spans.length - 1];
      if (lastSpan) lastSpan.b = 1;
      continue;
    }

    let text = it.str.replace(/ {2,}/g, ' ');

    if (prevVisible) {
      const gap = it.x - (prevVisible.x + prevVisible.w);
      const refH = Math.min(prevVisible.h, it.h);
      const spaceThreshold = Math.max(1.2, refH * 0.18);
      const prevEndsSpace = spans.length > 0 && spans[spans.length - 1].s.endsWith(' ');
      const currStartsSpace = text.startsWith(' ');

      if ((pendingSpace || gap > spaceThreshold) && !prevEndsSpace && !currStartsSpace) {
        spans.push({ s: ' ' });
      } else if (prevEndsSpace && currStartsSpace) {
        text = text.slice(1);
      }
    }
    pendingSpace = false;

    if (it.x < firstX) firstX = it.x;
    const endX = it.x + it.w;
    if (endX > lastXEnd) lastXEnd = endX;

    const trimmedLen = text.trim().length;
    const isSup =
      it.h <= lineFontSize * 0.72 &&
      it.yTop < baseY - lineFontSize * 0.12 &&
      trimmedLen > 0 &&
      trimmedLen <= 4;

    const span: TextSpan = { s: text };
    if (it.bold) span.b = 1;
    if (it.italic) span.i = 1;
    if (isSup) span.sup = 1;
    spans.push(span);

    totalNonSpaceChars += trimmedLen;
    if (it.bold) boldChars += trimmedLen;
    if (it.italic) italicChars += trimmedLen;

    prevVisible = it;
  }

  const cleanSpans = trimSpans(spans);
  if (cleanSpans.length === 0) return null;

  const fullText = cleanSpans.map((sp) => sp.s).join('');
  if (fullText.trim().length === 0) return null;

  return {
    pageNumber,
    pageHeight,
    text: fullText,
    spans: cleanSpans,
    x: firstX,
    xEnd: lastXEnd,
    yTop: baseY,
    fontSize: lineFontSize,
    allBold: totalNonSpaceChars > 0 && boldChars === totalNonSpaceChars,
    allItalic: totalNonSpaceChars > 0 && italicChars === totalNonSpaceChars,
    colLeft,
    colRight,
    column,
  };
}

interface ColumnSplit {
  splitX: number;
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
}

/** Detecta se uma página possui duas colunas com lacuna vertical central consistente. */
function detectTwoColumns(rows: RawRow[], pageWidth: number, pageHeight: number): ColumnSplit | null {
  const bodyRows = rows.filter(
    (r) => r.yTop >= pageHeight * 0.08 && r.yTop <= pageHeight * 0.92 && r.items.some((i) => !i.rawWhitespaceOnly),
  );
  if (bodyRows.length < 4) return null;

  let contentLeft = Infinity;
  let contentRight = -Infinity;
  const heights: number[] = [];

  for (const r of bodyRows) {
    for (const it of r.items) {
      if (it.rawWhitespaceOnly) continue;
      if (it.x < contentLeft) contentLeft = it.x;
      if (it.x + it.w > contentRight) contentRight = it.x + it.w;
      heights.push(it.h);
    }
  }

  const contentWidth = contentRight - contentLeft;
  if (!Number.isFinite(contentWidth) || contentWidth < pageWidth * 0.4) return null;

  const bodyH = median(heights, 12);
  const gutterMinGap = Math.max(10, bodyH * 1.1);
  const searchMin = contentLeft + contentWidth * 0.34;
  const searchMax = contentLeft + contentWidth * 0.66;
  const contentCenter = (contentLeft + contentRight) / 2;

  let best: {
    splitX: number;
    dualRows: number;
    crossingRows: number;
    medianGap: number;
    leftMin: number;
    leftMax: number;
    rightMin: number;
    rightMax: number;
  } | null = null;

  const step = Math.max(2, Math.floor((searchMax - searchMin) / 40));
  for (let splitX = searchMin; splitX <= searchMax; splitX += step) {
    let dualRows = 0;
    let crossingRows = 0;
    const gaps: number[] = [];
    let leftMin = Infinity;
    let leftMax = -Infinity;
    let rightMin = Infinity;
    let rightMax = -Infinity;

    for (const r of bodyRows) {
      let rowCrosses = false;
      let rLeftMax = -Infinity;
      let rLeftMin = Infinity;
      let rRightMin = Infinity;
      let rRightMax = -Infinity;

      for (const it of r.items) {
        if (it.rawWhitespaceOnly) continue;
        const x1 = it.x;
        const x2 = it.x + it.w;
        if (x1 + 1 < splitX && x2 - 1 > splitX) {
          rowCrosses = true;
          break;
        }
        if (x2 <= splitX + 1) {
          if (x1 < rLeftMin) rLeftMin = x1;
          if (x2 > rLeftMax) rLeftMax = x2;
        } else if (x1 >= splitX - 1) {
          if (x1 < rRightMin) rRightMin = x1;
          if (x2 > rRightMax) rRightMax = x2;
        }
      }

      if (rowCrosses) {
        crossingRows++;
        continue;
      }

      if (rLeftMax > -Infinity) {
        if (rLeftMin < leftMin) leftMin = rLeftMin;
        if (rLeftMax > leftMax) leftMax = rLeftMax;
      }
      if (rRightMin < Infinity) {
        if (rRightMin < rightMin) rightMin = rRightMin;
        if (rRightMax > rightMax) rightMax = rRightMax;
      }

      if (rLeftMax > -Infinity && rRightMin < Infinity) {
        const gap = rRightMin - rLeftMax;
        if (gap >= gutterMinGap) {
          dualRows++;
          gaps.push(gap);
        }
      }
    }

    const nonCrossing = bodyRows.length - crossingRows;
    if (dualRows < 3 || nonCrossing === 0) continue;
    if (crossingRows / bodyRows.length > 0.35) continue;
    if (dualRows / nonCrossing < 0.45) continue;

    const leftSpan = leftMax - leftMin;
    const rightSpan = rightMax - rightMin;
    if (leftSpan < contentWidth * 0.2 || rightSpan < contentWidth * 0.2) continue;

    const medGap = median(gaps, 0);
    if (medGap < gutterMinGap) continue;

    const isBetter =
      !best ||
      dualRows > best.dualRows ||
      (dualRows === best.dualRows && crossingRows < best.crossingRows) ||
      (dualRows === best.dualRows &&
        crossingRows === best.crossingRows &&
        (medGap > best.medianGap + 1 ||
          (Math.abs(medGap - best.medianGap) <= 1 &&
            Math.abs(splitX - contentCenter) < Math.abs(best.splitX - contentCenter))));

    if (isBetter) {
      best = { splitX, dualRows, crossingRows, medianGap: medGap, leftMin, leftMax, rightMin, rightMax };
    }
  }

  if (!best) return null;
  return {
    splitX: best.splitX,
    leftMin: best.leftMin,
    leftMax: best.leftMax,
    rightMin: best.rightMin,
    rightMax: best.rightMax,
  };
}

/** Constrói as linhas em ordem de leitura de uma página (com suporte a 2 colunas). */
function extractPageLines(page: PdfPageInput, yOrigin: 'pdf' | 'top-down'): LayoutLine[] {
  const normItems = normalizePageItems(page, yOrigin);
  if (normItems.length === 0) return [];

  const rows = groupIntoRawRows(normItems);
  const colSplit = detectTwoColumns(rows, page.width, page.height);

  // Limites horizontais gerais da página para layout de coluna única.
  let pageMinX = Infinity;
  let pageMaxX = -Infinity;
  for (const it of normItems) {
    if (it.rawWhitespaceOnly) continue;
    if (it.x < pageMinX) pageMinX = it.x;
    if (it.x + it.w > pageMaxX) pageMaxX = it.x + it.w;
  }
  if (!Number.isFinite(pageMinX)) return [];

  if (!colSplit) {
    const lines: LayoutLine[] = [];
    for (const r of rows) {
      const line = buildLayoutLine(r.items, page.pageNumber, page.height, pageMinX, pageMaxX, 0);
      if (line) lines.push(line);
    }
    return lines;
  }

  // Com duas colunas: separa faixas de largura total (linhas que cruzam a calha central)
  // e, dentro de cada faixa entre elas, lê coluna esquerda inteira e depois coluna direita inteira.
  const lines: LayoutLine[] = [];
  let bandLeft: NormItem[] = [];
  let bandRight: NormItem[] = [];

  const flushBand = () => {
    if (bandLeft.length > 0) {
      const leftRows = groupIntoRawRows(bandLeft);
      for (const lr of leftRows) {
        const line = buildLayoutLine(lr.items, page.pageNumber, page.height, colSplit.leftMin, colSplit.leftMax, 1);
        if (line) lines.push(line);
      }
      bandLeft = [];
    }
    if (bandRight.length > 0) {
      const rightRows = groupIntoRawRows(bandRight);
      for (const rr of rightRows) {
        const line = buildLayoutLine(rr.items, page.pageNumber, page.height, colSplit.rightMin, colSplit.rightMax, 2);
        if (line) lines.push(line);
      }
      bandRight = [];
    }
  };

  for (const r of rows) {
    const crosses = r.items.some(
      (it) => !it.rawWhitespaceOnly && it.x + 1 < colSplit.splitX && it.x + it.w - 1 > colSplit.splitX,
    );
    if (crosses) {
      flushBand();
      const line = buildLayoutLine(r.items, page.pageNumber, page.height, pageMinX, pageMaxX, 0);
      if (line) lines.push(line);
      continue;
    }

    for (const it of r.items) {
      const mid = it.x + it.w / 2;
      if (mid <= colSplit.splitX) bandLeft.push(it);
      else bandRight.push(it);
    }
  }
  flushBand();

  return lines;
}

const STANDALONE_PAGE_NUM_RE = /^[-–—·•|\[\]()\s]*(?:(?:p(?:ág|ag|age)?\.?\s*)?\d{1,5}(?:\s*(?:\/|de|of)\s*\d{1,5})?)[-–—·•|\[\]()\s]*$/i;
const ROMAN_PAGE_NUM_RE = /^[-–—\s]*(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})[-–—\s]*$/i;

function isStandalonePageNumber(line: LayoutLine, bodyFontSize: number): boolean {
  const text = stripSoftHyphens(line.text).trim();
  if (text.length === 0 || text.length > 24) return false;
  if (line.fontSize > bodyFontSize * 1.15) return false;
  const inTopOrBottom = line.yTop <= line.pageHeight * 0.14 || line.yTop >= line.pageHeight * 0.86;
  if (!inTopOrBottom) return false;
  if (STANDALONE_PAGE_NUM_RE.test(text)) return true;
  if (text.length <= 7 && ROMAN_PAGE_NUM_RE.test(text)) return true;
  return false;
}

/** Chave normalizada de cabeçalho/rodapé ignorando números e pontuação de borda. */
function headerFooterKey(text: string): string {
  return stripSoftHyphens(text)
    .toLowerCase()
    .replace(/\b\d+\b/g, '')
    .replace(/[-–—|·•/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove números de página isolados e cabeçalhos/rodapés repetidos em muitas páginas. */
function stripHeadersFootersAndPageNumbers(
  pagesLines: LayoutLine[][],
  bodyFontSize: number,
): LayoutLine[][] {
  const totalPages = pagesLines.length;
  const topCounts = new Map<string, Set<number>>();
  const bottomCounts = new Map<string, Set<number>>();

  for (let pi = 0; pi < totalPages; pi++) {
    const lines = pagesLines[pi];
    if (lines.length === 0) continue;
    const pageNum = lines[0].pageNumber;

    // Candidatos no topo (primeiras 2 linhas dentro de 14% superior).
    const topLimit = Math.min(2, lines.length);
    for (let i = 0; i < topLimit; i++) {
      const ln = lines[i];
      if (ln.yTop > ln.pageHeight * 0.14 || ln.fontSize > bodyFontSize * 1.15) continue;
      const key = headerFooterKey(ln.text);
      if (key.length > 0 && key.length <= 120) {
        let set = topCounts.get(key);
        if (!set) {
          set = new Set();
          topCounts.set(key, set);
        }
        set.add(pageNum);
      }
    }

    // Candidatos no rodapé (últimas 2 linhas dentro de 14% inferior).
    const botStart = Math.max(0, lines.length - 2);
    for (let i = botStart; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.yTop < ln.pageHeight * 0.86 || ln.fontSize > bodyFontSize * 1.15) continue;
      const key = headerFooterKey(ln.text);
      if (key.length > 0 && key.length <= 120) {
        let set = bottomCounts.get(key);
        if (!set) {
          set = new Set();
          bottomCounts.set(key, set);
        }
        set.add(pageNum);
      }
    }
  }

  const repeatedTop = new Set<string>();
  const repeatedBottom = new Set<string>();

  if (totalPages >= 3) {
    const globalMin = Math.max(2, Math.ceil(totalPages * 0.25));
    const checkRepeated = (counts: Map<string, Set<number>>, target: Set<string>) => {
      for (const [key, pageSet] of counts) {
        if (pageSet.size >= globalMin) {
          target.add(key);
          continue;
        }
        // Cabeçalhos correntes por capítulo em livros longos (ex.: >= 3 páginas próximas).
        if (totalPages >= 10 && pageSet.size >= 3) {
          const sortedPages = Array.from(pageSet).sort((a, b) => a - b);
          for (let i = 0; i + 2 < sortedPages.length; i++) {
            if (sortedPages[i + 2] - sortedPages[i] <= 8) {
              target.add(key);
              break;
            }
          }
        }
      }
    };
    checkRepeated(topCounts, repeatedTop);
    checkRepeated(bottomCounts, repeatedBottom);
  }

  return pagesLines.map((lines) =>
    lines.filter((ln, idx) => {
      if (isStandalonePageNumber(ln, bodyFontSize)) return false;

      if (idx < 2 && ln.yTop <= ln.pageHeight * 0.14 && ln.fontSize <= bodyFontSize * 1.15) {
        const key = headerFooterKey(ln.text);
        if (key.length > 0 && repeatedTop.has(key)) return false;
      }

      if (idx >= lines.length - 2 && ln.yTop >= ln.pageHeight * 0.86 && ln.fontSize <= bodyFontSize * 1.15) {
        const key = headerFooterKey(ln.text);
        if (key.length > 0 && repeatedBottom.has(key)) return false;
      }

      return true;
    }),
  );
}

/** Decide se uma quebra com hífen deve manter o hífen (palavra composta/clítico) ou desifenizar. */
function shouldKeepHyphen(prefix: string, suffix: string, isSuffixWholeWord: boolean): boolean {
  const lowerPrefix = prefix.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();

  // Próxima parte começa com maiúscula (e prefixo não é TUDO MAIÚSCULA): ex. "São-\nPaulo", "ex-\nPresidente".
  const suffixStartsUpper = /^\p{Lu}/u.test(suffix);
  const prefixAllUpper = prefix.length >= 2 && prefix === prefix.toUpperCase() && /\p{L}/u.test(prefix);
  if (suffixStartsUpper && !prefixAllUpper) return true;

  // Prefixos sempre hifenizados (ex-, vice-, bem-, pós-, pré-, recém-...).
  if (ALWAYS_HYPHEN_PREFIXES.has(lowerPrefix)) return true;

  // Pares compostos conhecidos (segunda-feira, guarda-chuva, obra-prima...).
  const pairSet = KNOWN_COMPOUND_PAIRS[lowerPrefix];
  if (pairSet && pairSet.has(lowerSuffix)) return true;

  // Regra do Acordo Ortográfico: mesma vogal final ou 'h' inicial (anti-inflamatório, micro-ondas, auto-hipnose).
  if (SAME_VOWEL_OR_H_PREFIXES.has(lowerPrefix)) {
    const lastChar = lowerPrefix[lowerPrefix.length - 1];
    const firstChar = lowerSuffix[0];
    if (firstChar === 'h' || firstChar === lastChar) return true;
  }

  // inter-/hiper-/super- antes de 'r' ou 'h' (super-herói, inter-regional).
  if (R_OR_H_PREFIXES.has(lowerPrefix)) {
    const firstChar = lowerSuffix[0];
    if (firstChar === 'h' || firstChar === 'r') return true;
  }

  // sub- antes de 'b', 'h' ou 'r' (sub-base, sub-reino, sub-humano).
  if (lowerPrefix === 'sub') {
    const firstChar = lowerSuffix[0];
    if (firstChar === 'b' || firstChar === 'h' || firstChar === 'r') return true;
  }

  // Pronomes clíticos em português (fazê-lo, disse-lhe, tornou-se).
  if (isSuffixWholeWord) {
    if (CLITIC_LO_SET.has(lowerSuffix) && /[áêîô]$/.test(lowerPrefix)) return true;
    if (CLITIC_LHE_SET.has(lowerSuffix) && lowerPrefix.length >= 3) return true;
    if (
      CLITIC_SE_SET.has(lowerSuffix) &&
      lowerPrefix.length >= 3 &&
      /(?:[aei]r|[aeo]u|[ae]m|ão|ia|va|ra|sse|ndo|mos|ei|oi|iz|az|ez)$/.test(lowerPrefix)
    ) {
      return true;
    }
  }

  return false;
}

/** Junta duas listas de spans (linha anterior + próxima linha), aplicando desifenização. */
function appendLineSpans(acc: TextSpan[], nextSpans: TextSpan[]): void {
  if (nextSpans.length === 0) return;
  if (acc.length === 0) {
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  const prevText = acc.map((s) => s.s).join('');
  const nextText = nextSpans.map((s) => s.s).join('');

  // Caso 1: soft hyphen (\u00AD) no fim da linha anterior -> sempre remove e junta.
  if (prevText.endsWith('\u00AD')) {
    removeTrailingChar(acc);
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  // Caso 2: hífen após letra + próxima linha começando com letra.
  const prevMatch = prevText.match(/(\p{L}+)[-‐]$/u);
  const nextMatch = nextText.match(/^(\p{L}+)(.*)$/u);
  if (prevMatch && nextMatch) {
    const prefix = prevMatch[1];
    const suffix = nextMatch[1];
    const rest = nextMatch[2];
    const isSuffixWholeWord = rest.length === 0 || /^[\s.,;:!?…"'”’)\]]/.test(rest);

    if (shouldKeepHyphen(prefix, suffix, isSuffixWholeWord)) {
      // Mantém o hífen sem inserir espaço.
      for (const sp of nextSpans) acc.push({ ...sp });
      return;
    }

    // Desifeniza: remove o hífen final e concatena diretamente.
    removeTrailingChar(acc);
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  // Caso padrão: une com um espaço.
  if (!prevText.endsWith(' ') && !nextText.startsWith(' ')) {
    acc.push({ s: ' ' });
  }
  for (const sp of nextSpans) acc.push({ ...sp });
}

function removeTrailingChar(spans: TextSpan[]): void {
  while (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (last.s.length > 0) {
      last.s = last.s.slice(0, -1);
      if (last.s.length === 0) spans.pop();
      return;
    }
    spans.pop();
  }
}

/** Finaliza spans em { text, runs? }, omitindo runs se o bloco não tiver estilos. */
function finalizeSpans(rawSpans: TextSpan[]): { text: string; runs?: Run[] } {
  const cleaned: TextSpan[] = [];
  for (const sp of rawSpans) {
    const s = stripSoftHyphens(sp.s).replace(/ {2,}/g, ' ');
    if (s.length === 0) continue;
    const item: TextSpan = { s };
    if (sp.b) item.b = 1;
    if (sp.i) item.i = 1;
    if (sp.sup) item.sup = 1;
    cleaned.push(item);
  }
  const trimmed = trimSpans(cleaned);
  const text = trimmed.map((r) => r.s).join('');
  const hasStyle = trimmed.some((r) => r.b === 1 || r.i === 1 || r.sup === 1);
  if (!hasStyle) return { text };
  return { text, runs: trimmed };
}

/** Remove prefixo de marcador de lista (N caracteres) preservando os estilos dos spans. */
function sliceSpansPrefix(spans: TextSpan[], prefixLen: number): TextSpan[] {
  let rem = prefixLen;
  const out: TextSpan[] = [];
  for (const sp of spans) {
    if (rem <= 0) {
      out.push({ ...sp });
    } else if (sp.s.length <= rem) {
      rem -= sp.s.length;
    } else {
      const rest = sp.s.slice(rem);
      rem = 0;
      if (rest.length > 0) out.push({ ...sp, s: rest });
    }
  }
  return trimSpans(out);
}

const UNORDERED_LIST_RE = /^([•●▪◦‣⁃■□◆◇▸▹►❖➢➤\-–])\s+(?=\S)/;
const ORDERED_LIST_RE = /^((?:\d{1,3}[.)]|[a-zA-Z]\)))\s+(?=\S)/;

function detectListMarker(text: string): { ordered: boolean; prefixLen: number } | null {
  const clean = stripSoftHyphens(text);
  const unord = clean.match(UNORDERED_LIST_RE);
  if (unord) return { ordered: false, prefixLen: unord[0].length };

  const ord = clean.match(ORDERED_LIST_RE);
  if (ord) {
    // Evita anos ou números absurdos como marcador de lista.
    const numMatch = ord[1].match(/^(\d+)/);
    if (numMatch && Number(numMatch[1]) > 200) return null;
    return { ordered: true, prefixLen: ord[0].length };
  }
  return null;
}

const TERMINAL_PUNCT_RE = /[.!?…:][”"'’»)\]]*$/;

/** Mapeia tamanhos de fonte de título (>= 1.18x corpo) para níveis 1, 2 ou 3. */
function buildHeadingLevelMap(allLines: LayoutLine[], bodyFontSize: number): (line: LayoutLine) => 1 | 2 | 3 | null {
  const minHeadingSize = bodyFontSize * 1.18;
  const sizeBuckets: number[] = [];

  for (const ln of allLines) {
    const clean = stripSoftHyphens(ln.text).trim();
    if (clean.length === 0 || clean.length > MAX_HEADING_LENGTH) continue;
    if (ln.fontSize < minHeadingSize) continue;
    if (detectListMarker(clean)) continue;
    if (/^\d+$/.test(clean)) continue;

    // Agrupa tamanhos dentro de ±0.8pt no mesmo patamar.
    const rounded = Math.round(ln.fontSize * 2) / 2;
    if (!sizeBuckets.some((s) => Math.abs(s - rounded) <= 0.8)) {
      sizeBuckets.push(rounded);
    }
  }

  sizeBuckets.sort((a, b) => b - a); // Maior -> nível 1

  return (ln: LayoutLine): 1 | 2 | 3 | null => {
    const clean = stripSoftHyphens(ln.text).trim();
    if (clean.length === 0 || clean.length > MAX_HEADING_LENGTH) return null;
    if (ln.fontSize < minHeadingSize) return null;
    if (detectListMarker(clean)) return null;
    if (/^\d+$/.test(clean)) return null;

    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < sizeBuckets.length; i++) {
      const diff = Math.abs(ln.fontSize - sizeBuckets[i]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const lvl = Math.min(3, bestIdx + 1);
    return lvl as 1 | 2 | 3;
  };
}

/** Estima o espaçamento vertical normal entre linhas do corpo. */
function estimateNormalLineStep(pagesLines: LayoutLine[][], bodyFontSize: number): number {
  const steps: number[] = [];
  for (const lines of pagesLines) {
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];
      if (prev.column !== curr.column) continue;
      if (Math.abs(prev.fontSize - bodyFontSize) > bodyFontSize * 0.2) continue;
      if (Math.abs(curr.fontSize - bodyFontSize) > bodyFontSize * 0.2) continue;
      const step = curr.yTop - prev.yTop;
      if (step >= bodyFontSize * 0.8 && step <= bodyFontSize * 2.5) {
        steps.push(step);
      }
    }
  }
  return median(steps, bodyFontSize * 1.35);
}

/** Estima a margem esquerda base por (página, coluna) para detectar recuos de primeira linha. */
function computeColumnBaseLeft(lines: LayoutLine[], bodyFontSize: number): Map<number, number> {
  const byCol = new Map<number, number[]>();
  for (const ln of lines) {
    if (Math.abs(ln.fontSize - bodyFontSize) > bodyFontSize * 0.25) continue;
    let arr = byCol.get(ln.column);
    if (!arr) {
      arr = [];
      byCol.set(ln.column, arr);
    }
    arr.push(ln.x);
  }
  const result = new Map<number, number>();
  for (const [col, xs] of byCol) {
    result.set(col, percentile(xs, 0.2, xs[0]));
  }
  return result;
}

/** Converte páginas de linhas em blocos (títulos, parágrafos, listas e imagens isoladas). */
function buildBlocks(
  pages: PdfPageInput[],
  pagesLines: LayoutLine[][],
  bodyFontSize: number,
  normalStep: number,
  outlineBreakPages: Set<number>,
): TaggedBlock[] {
  const allLines = pagesLines.flat();
  const classifyHeading = buildHeadingLevelMap(allLines, bodyFontSize);

  const blocks: TaggedBlock[] = [];

  // Estado do bloco textual em construção (p ou li).
  let currentKind: 'p' | 'li' | null = null;
  let currentOrdered = false;
  let currentSpans: TextSpan[] = [];
  let currentStartPage = 1;
  let prevLine: LayoutLine | null = null;
  let prevColBaseX = 0;

  const flushCurrent = () => {
    if (!currentKind || currentSpans.length === 0) {
      currentKind = null;
      currentSpans = [];
      return;
    }
    const { text, runs } = finalizeSpans(currentSpans);
    if (text.length > 0) {
      if (currentKind === 'li') {
        const blk: Block = {
          t: 'li',
          text,
          ...(runs ? { runs } : {}),
          ...(currentOrdered ? { ordered: true } : {}),
        };
        blocks.push({ block: blk, pageNumber: currentStartPage });
      } else {
        const blk: Block = {
          t: 'p',
          text,
          ...(runs ? { runs } : {}),
        };
        blocks.push({ block: blk, pageNumber: currentStartPage });
      }
    }
    currentKind = null;
    currentOrdered = false;
    currentSpans = [];
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const lines = pagesLines[pi];

    // Uma página de destino do sumário sempre inicia bloco novo para permitir corte exato de capítulo.
    if (outlineBreakPages.has(page.pageNumber)) {
      flushCurrent();
      prevLine = null;
    }

    // Página isolada sem texto com imagem de fallback (ex.: figura de página inteira).
    if (lines.length === 0) {
      if (page.fallbackImage) {
        flushCurrent();
        prevLine = null;
        blocks.push({
          block: {
            t: 'img',
            src: page.fallbackImage.src,
            alt: page.fallbackImage.alt ?? `Página ${page.pageNumber}`,
            w: page.fallbackImage.w,
            h: page.fallbackImage.h,
          },
          pageNumber: page.pageNumber,
        });
      }
      continue;
    }

    const colBaseMap = computeColumnBaseLeft(lines, bodyFontSize);

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const colBaseX = colBaseMap.get(line.column) ?? line.colLeft;
      const colWidth = Math.max(1, line.colRight - colBaseX);

      // 1. Título detectado pela fonte.
      const headingLevel = classifyHeading(line);
      if (headingLevel !== null) {
        flushCurrent();
        let headingText = stripSoftHyphens(line.text).trim();
        let lastHeadingLine = line;

        // Junta linhas consecutivas do mesmo título se continuarem curtas.
        while (li + 1 < lines.length) {
          const next = lines[li + 1];
          if (next.column !== line.column) break;
          if (classifyHeading(next) !== headingLevel) break;
          if (Math.abs(next.fontSize - line.fontSize) > 1.2) break;
          const vGap = next.yTop - lastHeadingLine.yTop;
          if (vGap < 0 || vGap > line.fontSize * 1.9) break;
          const nextClean = stripSoftHyphens(next.text).trim();
          const joined = `${headingText} ${nextClean}`;
          if (joined.length > MAX_HEADING_LENGTH) break;
          headingText = joined;
          lastHeadingLine = next;
          li++;
        }

        blocks.push({
          block: { t: 'h', level: headingLevel, text: headingText },
          pageNumber: page.pageNumber,
        });
        prevLine = null;
        continue;
      }

      // 2. Item de lista.
      const listInfo = detectListMarker(line.text);
      if (listInfo) {
        flushCurrent();
        currentKind = 'li';
        currentOrdered = listInfo.ordered;
        currentStartPage = page.pageNumber;
        currentSpans = sliceSpansPrefix(line.spans, listInfo.prefixLen);
        prevLine = line;
        prevColBaseX = colBaseX;
        continue;
      }

      // 3. Linha de texto comum: decide se continua o bloco anterior ou inicia novo parágrafo.
      let startNewParagraph = currentKind === null;

      if (!startNewParagraph && prevLine) {
        const samePage = prevLine.pageNumber === line.pageNumber;
        const sameColumn = samePage && prevLine.column === line.column;
        const prevClean = stripSoftHyphens(prevLine.text).trim();
        const prevEndsHyphen =
          prevLine.text.endsWith('\u00AD') || /\p{L}[-‐]$/u.test(prevClean);
        const prevEndsTerminal = TERMINAL_PUNCT_RE.test(prevClean);

        const currIndent = line.x - colBaseX;
        const hasFirstLineIndent =
          currIndent >= Math.max(8, line.fontSize * 0.75) &&
          currIndent <= colWidth * 0.35 &&
          // Em continuação de item de lista (recuo deslocado), o alinhamento segue o texto do item.
          !(currentKind === 'li' && Math.abs(line.x - prevLine.x) <= line.fontSize * 1.8);

        const prevWidth = prevLine.xEnd - prevLine.x;
        const prevColWidth = Math.max(1, prevLine.colRight - prevColBaseX);
        const prevRightMarginGap = prevLine.colRight - prevLine.xEnd;
        const prevIsShort =
          prevRightMarginGap >= Math.max(prevLine.fontSize * 2.5, prevColWidth * 0.15) ||
          prevWidth < prevColWidth * 0.82;

        if (sameColumn) {
          const vStep = line.yTop - prevLine.yTop;
          const hasLargeGap = vStep > normalStep * 1.32 && vStep > Math.max(prevLine.fontSize, line.fontSize) * 1.5;

          if (hasLargeGap) {
            startNewParagraph = true;
          } else if (hasFirstLineIndent && !prevEndsHyphen) {
            // Evita falso positivo se a linha anterior também tinha exatamente o mesmo recuo
            // (ex.: bloco citado ou recuado) e não terminou em pontuação final.
            const sameIndentBlock = Math.abs(line.x - prevLine.x) <= 2.5;
            if (!sameIndentBlock || prevEndsTerminal) {
              startNewParagraph = true;
            }
          } else if (prevIsShort && prevEndsTerminal && !prevEndsHyphen) {
            startNewParagraph = true;
          }
        } else {
          // Mudança de coluna ou de página: mantém contínuo se a frase foi interrompida no meio ou hifenizada.
          if (prevEndsHyphen) {
            startNewParagraph = false;
          } else if (hasFirstLineIndent || prevEndsTerminal) {
            startNewParagraph = true;
          }
        }
      }

      if (startNewParagraph) {
        flushCurrent();
        currentKind = 'p';
        currentOrdered = false;
        currentStartPage = page.pageNumber;
        currentSpans = line.spans.map((s) => ({ ...s }));
      } else {
        appendLineSpans(currentSpans, line.spans);
      }

      prevLine = line;
      prevColBaseX = colBaseX;
    }
  }

  flushCurrent();
  return blocks;
}

function blockCharCount(block: Block): number {
  return 'text' in block ? block.text.length : 0;
}

function normalizeTitleForMatch(title: string): string {
  return normalizePdfText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Divide blocos em capítulos usando o sumário do PDF (outline). */
function splitByOutline(blocks: TaggedBlock[], outline: PdfOutlineEntry[]): Chapter[] {
  const valid = outline
    .map((e) => ({
      title: normalizePdfText(e.title).trim(),
      pageNumber: e.pageNumber,
      level: e.level ?? 0,
    }))
    .filter((e) => e.title.length > 0 && e.pageNumber >= 1);

  if (valid.length === 0) return [];

  // Escolhe o nível raiz do sumário; se houver só 1 raiz (título do livro) e vários filhos, usa os filhos.
  let minLevel = valid[0].level;
  for (const e of valid) if (e.level < minLevel) minLevel = e.level;
  let chosen = valid.filter((e) => e.level === minLevel);
  if (chosen.length === 1) {
    const nextLevel = valid.filter((e) => e.level === minLevel + 1);
    if (nextLevel.length >= 2) chosen = nextLevel;
  }

  chosen.sort((a, b) => a.pageNumber - b.pageNumber);

  // Resolve o índice exato do bloco onde cada capítulo do sumário começa.
  const cuts: Array<{ idx: number; title: string }> = [];
  let minSearchIdx = 0;

  for (const entry of chosen) {
    const firstOnOrAfter = blocks.findIndex((b, idx) => idx >= minSearchIdx && b.pageNumber >= entry.pageNumber);
    if (firstOnOrAfter === -1) continue;

    // Tenta casar com um título na página de destino para um corte exato no meio da página.
    const entryNorm = normalizeTitleForMatch(entry.title);
    let cutIdx = firstOnOrAfter;
    for (let i = firstOnOrAfter; i < blocks.length && blocks[i].pageNumber === entry.pageNumber; i++) {
      const blk = blocks[i].block;
      if (blk.t === 'h') {
        const blkNorm = normalizeTitleForMatch(blk.text);
        if (blkNorm && entryNorm && (blkNorm === entryNorm || blkNorm.includes(entryNorm) || entryNorm.includes(blkNorm))) {
          cutIdx = i;
          break;
        }
      }
    }

    if (cuts.length > 0 && cuts[cuts.length - 1].idx === cutIdx) {
      // Dois itens de sumário apontando para exatamente o mesmo ponto: mantém o primeiro ou concatena.
      continue;
    }

    cuts.push({ idx: cutIdx, title: entry.title });
    minSearchIdx = cutIdx + 1;
  }

  if (cuts.length === 0) return [];

  const chapters: Chapter[] = [];

  // Blocos anteriores ao primeiro capítulo do sumário (folha de rosto, prefácio, etc.).
  if (cuts[0].idx > 0) {
    const preBlocks = blocks.slice(0, cuts[0].idx);
    const firstHeading = preBlocks.find((b) => b.block.t === 'h');
    const preTitle =
      firstHeading && firstHeading.block.t === 'h'
        ? firstHeading.block.text
        : formatPageRangeTitle(preBlocks[0].pageNumber, preBlocks[preBlocks.length - 1].pageNumber);
    chapters.push({ title: preTitle, blocks: preBlocks.map((b) => b.block) });
  }

  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i].idx;
    const end = i + 1 < cuts.length ? cuts[i + 1].idx : blocks.length;
    const slice = blocks.slice(start, end).map((b) => b.block);
    if (slice.length === 0) continue;
    chapters.push({ title: cuts[i].title, blocks: slice });
  }

  return chapters;
}

function formatPageRangeTitle(startPage: number, endPage: number): string {
  if (startPage === endPage) return `Página ${startPage}`;
  return `Páginas ${startPage}–${endPage}`;
}

/** Divide blocos em capítulos pelos títulos detectados (nível 1 ou maior nível existente). */
function splitByHeadings(blocks: TaggedBlock[]): Chapter[] {
  let minLevel: 1 | 2 | 3 | null = null;
  let level1Count = 0;
  let level2Count = 0;
  let firstLevel1Idx = -1;

  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i].block;
    if (blk.t !== 'h') continue;
    if (minLevel === null || blk.level < minLevel) minLevel = blk.level;
    if (blk.level === 1) {
      level1Count++;
      if (firstLevel1Idx === -1) firstLevel1Idx = i;
    } else if (blk.level === 2) {
      level2Count++;
    }
  }

  if (minLevel === null) return [];

  // Se houver apenas 1 título nível 1 logo no início (título do livro) e vários nível 2, corta também nos nível 2.
  const splitMaxLevel: 1 | 2 | 3 =
    minLevel === 1 && level1Count === 1 && firstLevel1Idx <= 4 && level2Count >= 2 ? 2 : minLevel;

  const chapters: Chapter[] = [];
  let currentTitle: string | null = null;
  let currentBlocks: TaggedBlock[] = [];

  const flush = () => {
    if (currentBlocks.length === 0) return;
    const title =
      currentTitle ??
      formatPageRangeTitle(currentBlocks[0].pageNumber, currentBlocks[currentBlocks.length - 1].pageNumber);
    chapters.push({ title, blocks: currentBlocks.map((b) => b.block) });
    currentBlocks = [];
  };

  for (const item of blocks) {
    if (item.block.t === 'h' && item.block.level <= splitMaxLevel) {
      flush();
      currentTitle = item.block.text;
      currentBlocks = [item];
    } else {
      currentBlocks.push(item);
    }
  }
  flush();

  return chapters;
}

/** Divide blocos em capítulos fixos de ~N páginas quando não há títulos nem sumário. */
function splitByPageChunks(blocks: TaggedBlock[], totalPages: number, pagesPerChapter: number): Chapter[] {
  if (blocks.length === 0) return [];
  const step = Math.max(1, pagesPerChapter);
  const maxPage = Math.max(totalPages, blocks[blocks.length - 1].pageNumber);
  const chapters: Chapter[] = [];

  for (let start = 1; start <= maxPage; start += step) {
    const end = Math.min(maxPage, start + step - 1);
    const slice = blocks.filter((b) => b.pageNumber >= start && b.pageNumber <= end).map((b) => b.block);
    if (slice.length === 0) continue;
    chapters.push({
      title: formatPageRangeTitle(start, end),
      blocks: slice,
    });
  }

  return chapters;
}

/** Quebra um parágrafo excepcionalmente gigante (> maxChars) em pedaços menores. */
function splitOversizedBlock(blk: Block, maxChars: number): Block[] {
  if (blk.t !== 'p' || blk.text.length <= maxChars) return [blk];
  const pieces: Block[] = [];
  let offset = 0;
  const text = blk.text;
  while (offset < text.length) {
    if (text.length - offset <= maxChars) {
      pieces.push({ t: 'p', text: text.slice(offset).trim() });
      break;
    }
    const end = offset + maxChars;
    let cut = text.lastIndexOf('. ', end);
    if (cut <= offset + maxChars * 0.5) cut = text.lastIndexOf(' ', end);
    if (cut <= offset) cut = end;
    else cut += 1;
    const chunk = text.slice(offset, cut).trim();
    if (chunk.length > 0) pieces.push({ t: 'p', text: chunk });
    offset = cut;
  }
  return pieces.length > 0 ? pieces : [blk];
}

/** Garante que nenhum capítulo exceda `maxChars` caracteres, dividindo em "(cont.)". */
function enforceChapterCharLimit(chapters: Chapter[], maxChars: number): Chapter[] {
  if (maxChars <= 0) return chapters;
  const out: Chapter[] = [];

  for (const ch of chapters) {
    let total = 0;
    for (const blk of ch.blocks) total += blockCharCount(blk);
    if (total <= maxChars) {
      out.push(ch);
      continue;
    }

    const flatBlocks: Block[] = [];
    for (const blk of ch.blocks) {
      if (blockCharCount(blk) > maxChars) {
        flatBlocks.push(...splitOversizedBlock(blk, maxChars));
      } else {
        flatBlocks.push(blk);
      }
    }

    const parts: Block[][] = [];
    let part: Block[] = [];
    let partChars = 0;

    for (const blk of flatBlocks) {
      const len = blockCharCount(blk);
      if (part.length > 0 && partChars + len > maxChars) {
        parts.push(part);
        part = [];
        partChars = 0;
      }
      part.push(blk);
      partChars += len;
    }
    if (part.length > 0) parts.push(part);

    for (let i = 0; i < parts.length; i++) {
      const title =
        i === 0
          ? ch.title
          : i === 1
            ? `${ch.title} (cont.)`
            : `${ch.title} (${i + 1}) (cont.)`;
      out.push({ title, blocks: parts[i] });
    }
  }

  return out;
}

/**
 * Converte páginas extraídas de um PDF em capítulos refluíveis (`Chapter[]`).
 */
export function extractPdfChapters(pages: PdfPageInput[], options: PdfLayoutOptions = {}): Chapter[] {
  if (pages.length === 0) return [];

  const yOrigin = options.yOrigin ?? 'pdf';
  const maxChapterChars = options.maxChapterChars ?? DEFAULT_MAX_CHAPTER_CHARS;
  const pagesPerChapter = options.pagesPerChapter ?? DEFAULT_PAGES_PER_CHAPTER;

  // 1. Extrai linhas de cada página (com detecção de 2 colunas).
  const rawPagesLines = pages.map((p) => extractPageLines(p, yOrigin));

  // 2. Mediana do tamanho da fonte do corpo (ponderada por quantidade de caracteres).
  const fontWeights: Array<{ value: number; weight: number }> = [];
  for (const lines of rawPagesLines) {
    for (const ln of lines) {
      const len = stripSoftHyphens(ln.text).trim().length;
      if (len > 0) fontWeights.push({ value: Math.round(ln.fontSize * 2) / 2, weight: len });
    }
  }
  const bodyFontSize = weightedMedian(fontWeights, 12);

  // 3. Remove cabeçalhos/rodapés repetidos e números de página isolados.
  const cleanPagesLines = stripHeadersFootersAndPageNumbers(rawPagesLines, bodyFontSize);

  // 4. Calcula espaçamento normal entre linhas do corpo e reconstrói blocos.
  const normalStep = estimateNormalLineStep(cleanPagesLines, bodyFontSize);
  const outlineBreakPages = new Set<number>();
  if (options.outline) {
    for (const entry of options.outline) {
      if (entry.pageNumber >= 1) outlineBreakPages.add(entry.pageNumber);
    }
  }
  const taggedBlocks = buildBlocks(pages, cleanPagesLines, bodyFontSize, normalStep, outlineBreakPages);
  if (taggedBlocks.length === 0) return [];

  // 5. Divide em capítulos: prioridade para sumário (outline), depois títulos, depois faixas de páginas.
  let chapters: Chapter[] = [];
  if (options.outline && options.outline.length > 0) {
    chapters = splitByOutline(taggedBlocks, options.outline);
  }
  if (chapters.length === 0) {
    chapters = splitByHeadings(taggedBlocks);
  }
  if (chapters.length === 0) {
    chapters = splitByPageChunks(taggedBlocks, pages.length, pagesPerChapter);
  }

  // 6. Limita o tamanho máximo de cada capítulo (~60 mil caracteres).
  return enforceChapterCharLimit(chapters, maxChapterChars);
}
