import type { Block, Run } from '../types';

export interface HtmlBlocksOptions {
  /** Resolve um `src`/`href` de imagem para a chave local em `ParsedBook.images`. */
  resolveImage?: (rawSrc: string) => string | undefined;
}

const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'nav']);

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'header',
  'footer',
  'figure',
  'figcaption',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'pre',
  'table',
  'hr',
  'address',
  'dl',
  'dt',
  'dd',
]);

const HEADING_LEVELS: Record<string, 1 | 2 | 3> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 3,
  h5: 3,
  h6: 3,
};

interface InlineStyle {
  b?: 1;
  i?: 1;
  sup?: 1;
}

function tagName(el: Element): string {
  return (el.localName || el.tagName).toLowerCase();
}

function collapseWs(text: string): string {
  return text.replace(/[\t\r\n\f\v ]+/g, ' ');
}

function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return a.b === b.b && a.i === b.i && a.sup === b.sup;
}

function makeRun(s: string, style: InlineStyle): Run {
  const run: Run = { s };
  if (style.b) run.b = 1;
  if (style.i) run.i = 1;
  if (style.sup) run.sup = 1;
  return run;
}

/** Normaliza espaços entre runs, remove espaços nas bordas e ao redor de `\n`, e mescla runs iguais. */
function finalizeRuns(rawRuns: Run[]): { text: string; runs?: Run[] } | null {
  const merged: Run[] = [];
  let endsWithSpaceOrBreak = true; // evita espaço no início do bloco

  for (const run of rawRuns) {
    let s = run.s;
    if (!s) continue;

    // Remove espaço imediatamente após quebra de linha ou no início
    if (endsWithSpaceOrBreak && s.startsWith(' ')) {
      s = s.slice(1);
    }
    // Remove espaço antes de '\n'
    s = s.replace(/ +\n/g, '\n').replace(/\n +/g, '\n');
    if (!s) continue;

    // Se o novo trecho começa com '\n', remove espaço pendente no run anterior
    if (s.startsWith('\n') && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.s.endsWith(' ')) {
        prev.s = prev.s.slice(0, -1);
        if (!prev.s) merged.pop();
      }
    }

    const last = merged[merged.length - 1];
    if (last && sameStyle(last, run)) {
      last.s += s;
    } else {
      merged.push(makeRun(s, run));
    }
    endsWithSpaceOrBreak = s.endsWith(' ') || s.endsWith('\n');
  }

  // Remove espaços/quebras finais
  while (merged.length > 0) {
    const last = merged[merged.length - 1];
    last.s = last.s.replace(/[ \n]+$/g, '');
    if (!last.s) {
      merged.pop();
    } else {
      break;
    }
  }

  // Remove quebras iniciais se houver
  while (merged.length > 0) {
    const first = merged[0];
    first.s = first.s.replace(/^[ \n]+/g, '');
    if (!first.s) {
      merged.shift();
    } else {
      break;
    }
  }

  if (merged.length === 0) return null;

  const text = merged.map((r) => r.s).join('');
  if (!text) return null;

  const hasFormatting = merged.some((r) => r.b === 1 || r.i === 1 || r.sup === 1);
  return hasFormatting ? { text, runs: merged } : { text };
}

function parsePositiveInt(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildImgBlock(
  rawSrc: string | null,
  alt: string | null,
  wAttr: string | null,
  hAttr: string | null,
  opts: HtmlBlocksOptions,
): Block | null {
  if (!rawSrc) return null;
  const trimmed = rawSrc.trim();
  if (!trimmed) return null;
  const src = opts.resolveImage ? opts.resolveImage(trimmed) : trimmed;
  if (!src) return null;

  const block: Block = { t: 'img', src };
  const cleanAlt = alt?.trim();
  if (cleanAlt) block.alt = cleanAlt;
  const w = parsePositiveInt(wAttr);
  const h = parsePositiveInt(hAttr);
  if (w) block.w = w;
  if (h) block.h = h;
  return block;
}

function extractImageFromSvg(svg: Element, opts: HtmlBlocksOptions): Block[] {
  const blocks: Block[] = [];
  const images = svg.getElementsByTagName('image');
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const href =
      img.getAttribute('href') ??
      img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      img.getAttribute('xlink:href');
    const block = buildImgBlock(href, null, img.getAttribute('width'), img.getAttribute('height'), opts);
    if (block) blocks.push(block);
  }
  return blocks;
}

function nextStyle(tag: string, current: InlineStyle): InlineStyle {
  if (tag === 'b' || tag === 'strong') return { ...current, b: 1 };
  if (tag === 'i' || tag === 'em' || tag === 'cite') return { ...current, i: 1 };
  if (tag === 'sup') return { ...current, sup: 1 };
  return current;
}

/** Coleta runs inline, quebrando em blocos `img` quando encontra `<img>` ou `<svg><image>`. */
function collectInline(
  node: Node,
  style: InlineStyle,
  runs: Run[],
  out: Block[],
  flushText: () => void,
  opts: HtmlBlocksOptions,
): void {
  if (node.nodeType === 3) {
    const collapsed = collapseWs(node.textContent ?? '');
    if (collapsed) runs.push(makeRun(collapsed, style));
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  const tag = tagName(el);
  if (IGNORED_TAGS.has(tag)) return;

  if (tag === 'br') {
    runs.push({ s: '\n' });
    return;
  }

  if (tag === 'img') {
    flushText();
    const img = buildImgBlock(
      el.getAttribute('src'),
      el.getAttribute('alt'),
      el.getAttribute('width'),
      el.getAttribute('height'),
      opts,
    );
    if (img) out.push(img);
    return;
  }

  if (tag === 'svg') {
    const imgs = extractImageFromSvg(el, opts);
    if (imgs.length > 0) {
      flushText();
      out.push(...imgs);
    }
    return;
  }

  const childStyle = nextStyle(tag, style);
  for (let i = 0; i < el.childNodes.length; i++) {
    collectInline(el.childNodes[i], childStyle, runs, out, flushText, opts);
  }
}

function collectPlainRuns(node: Node, style: InlineStyle, runs: Run[]): void {
  if (node.nodeType === 3) {
    const collapsed = collapseWs(node.textContent ?? '');
    if (collapsed) runs.push(makeRun(collapsed, style));
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  const tag = tagName(el);
  if (IGNORED_TAGS.has(tag)) return;
  if (tag === 'br') {
    runs.push({ s: '\n' });
    return;
  }

  const childStyle = nextStyle(tag, style);
  const isBlockBoundary = tag === 'p' || tag === 'div' || tag === 'li';
  if (isBlockBoundary && runs.length > 0) {
    runs.push({ s: '\n' });
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    collectPlainRuns(el.childNodes[i], childStyle, runs);
  }
  if (isBlockBoundary && runs.length > 0) {
    runs.push({ s: '\n' });
  }
}

function processTable(table: Element, out: Block[]): void {
  const rows = table.getElementsByTagName('tr');
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    // Evita processar linhas de tabelas aninhadas duas vezes
    let parent: Element | null = row.parentElement;
    while (parent && parent !== table && tagName(parent) !== 'table') {
      parent = parent.parentElement;
    }
    if (parent !== table) continue;

    const rowRuns: Run[] = [];
    let hasCell = false;
    for (let c = 0; c < row.children.length; c++) {
      const cell = row.children[c];
      const cellTag = tagName(cell);
      if (cellTag !== 'td' && cellTag !== 'th') continue;

      const cellRuns: Run[] = [];
      collectPlainRuns(cell, {}, cellRuns);
      const finalized = finalizeRuns(cellRuns);
      if (!finalized) continue;

      if (hasCell) rowRuns.push({ s: ' · ' });
      if (finalized.runs) rowRuns.push(...finalized.runs);
      else rowRuns.push({ s: finalized.text });
      hasCell = true;
    }

    const rowFinal = finalizeRuns(rowRuns);
    if (rowFinal) {
      out.push(rowFinal.runs ? { t: 'p', text: rowFinal.text, runs: rowFinal.runs } : { t: 'p', text: rowFinal.text });
    }
  }
}

function processList(listEl: Element, ordered: boolean, out: Block[], opts: HtmlBlocksOptions): void {
  for (let i = 0; i < listEl.children.length; i++) {
    const child = listEl.children[i];
    const tag = tagName(child);
    if (tag === 'li') {
      processListItem(child, ordered, out, opts);
    } else if (tag === 'ul' || tag === 'ol') {
      processList(child, tag === 'ol', out, opts);
    }
  }
}

function processListItem(li: Element, ordered: boolean, out: Block[], opts: HtmlBlocksOptions): void {
  let runs: Run[] = [];
  const flushLi = () => {
    const res = finalizeRuns(runs);
    runs = [];
    if (res) {
      out.push(res.runs ? { t: 'li', text: res.text, runs: res.runs, ordered } : { t: 'li', text: res.text, ordered });
    }
  };

  for (let i = 0; i < li.childNodes.length; i++) {
    const child = li.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      const tag = tagName(el);
      if (tag === 'ul' || tag === 'ol') {
        flushLi();
        processList(el, tag === 'ol', out, opts);
        continue;
      }
      if (tag === 'p' || tag === 'div') {
        if (runs.length > 0) runs.push({ s: '\n' });
        collectInline(el, {}, runs, out, flushLi, opts);
        continue;
      }
    }
    collectInline(child, {}, runs, out, flushLi, opts);
  }
  flushLi();
}

function processBlockElement(el: Element, out: Block[], opts: HtmlBlocksOptions): void {
  const tag = tagName(el);
  if (IGNORED_TAGS.has(tag)) return;

  if (tag === 'hr') {
    out.push({ t: 'hr' });
    return;
  }

  const headingLevel = HEADING_LEVELS[tag];
  if (headingLevel) {
    const runs: Run[] = [];
    collectPlainRuns(el, {}, runs);
    const res = finalizeRuns(runs);
    if (res) out.push({ t: 'h', level: headingLevel, text: res.text });
    return;
  }

  if (tag === 'pre') {
    const raw = (el.textContent ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (raw.trim().length > 0) out.push({ t: 'pre', text: raw });
    return;
  }

  if (tag === 'blockquote') {
    const runs: Run[] = [];
    collectPlainRuns(el, {}, runs);
    const res = finalizeRuns(runs);
    if (res) {
      out.push(res.runs ? { t: 'quote', text: res.text, runs: res.runs } : { t: 'quote', text: res.text });
    }
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    processList(el, tag === 'ol', out, opts);
    return;
  }

  if (tag === 'li') {
    processListItem(el, false, out, opts);
    return;
  }

  if (tag === 'table') {
    processTable(el, out);
    return;
  }

  if (tag === 'p') {
    let runs: Run[] = [];
    const flushP = () => {
      const res = finalizeRuns(runs);
      runs = [];
      if (res) {
        out.push(res.runs ? { t: 'p', text: res.text, runs: res.runs } : { t: 'p', text: res.text });
      }
    };
    for (let i = 0; i < el.childNodes.length; i++) {
      collectInline(el.childNodes[i], {}, runs, out, flushP, opts);
    }
    flushP();
    return;
  }

  // Contêiner genérico (div, section, article, body, etc.)
  processContainer(el, out, opts);
}

function processContainer(container: Element, out: Block[], opts: HtmlBlocksOptions): void {
  let runs: Run[] = [];
  const flushP = () => {
    const res = finalizeRuns(runs);
    runs = [];
    if (res) {
      out.push(res.runs ? { t: 'p', text: res.text, runs: res.runs } : { t: 'p', text: res.text });
    }
  };

  for (let i = 0; i < container.childNodes.length; i++) {
    const child = container.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      const tag = tagName(el);
      if (IGNORED_TAGS.has(tag)) continue;
      if (BLOCK_TAGS.has(tag)) {
        flushP();
        processBlockElement(el, out, opts);
        continue;
      }
    }
    collectInline(child, {}, runs, out, flushP, opts);
  }
  flushP();
}

/** Converte um Document XHTML/HTML em lista de blocos refluíveis (`Block[]`). */
export function htmlToBlocks(doc: Document, opts: HtmlBlocksOptions = {}): Block[] {
  const root = doc.body ?? doc.documentElement;
  if (!root) return [];
  const blocks: Block[] = [];
  processContainer(root, blocks, opts);
  return blocks;
}
