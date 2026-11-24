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

const INLINE_BLOCK_SEPARATORS = new Set([...BLOCK_TAGS, 'summary', 'tr', 'caption']);
const INLINE_SPACE_SEPARATORS = new Set(['td', 'th']);

const PLAIN_BOUNDARY_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dt',
  'dd',
  'blockquote',
  'section',
  'article',
  'figure',
  'figcaption',
  'caption',
  'summary',
]);
const PLAIN_SPACE_TAGS = new Set(['td', 'th']);

const LIST_DELEGATE_TAGS = new Set(['blockquote', 'pre', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CONTAINER_DELEGATE_TRIGGERS = new Set([
  'blockquote',
  'pre',
  'table',
  'ul',
  'ol',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
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
  const raw = (el.localName || el.tagName).toLowerCase();
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
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

function pushSeparator(runs: Run[], sep: '\n' | ' '): void {
  if (runs.length === 0) return;
  const last = runs[runs.length - 1].s;
  if (last.endsWith('\n')) return;
  if (sep === ' ' && last.endsWith(' ')) return;
  runs.push({ s: sep });
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
  const m = /^\s*(\d+)(?:\.\d+)?(?:px)?\s*$/i.exec(val);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
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

function collectSvgImageElements(node: Element, out: Element[]): void {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = tagName(el);
    if (tag === 'image' || tag.endsWith(':image')) {
      out.push(el);
    } else {
      collectSvgImageElements(el, out);
    }
  }
}

function extractImageFromSvg(svg: Element, opts: HtmlBlocksOptions): Block[] {
  const blocks: Block[] = [];
  const images: Element[] = [];
  collectSvgImageElements(svg, images);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const href =
      img.getAttribute('href') ??
      (typeof img.getAttributeNS === 'function' ? img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null) ??
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

function buildPreBlock(el: Element): Block | null {
  const raw = (el.textContent ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  return raw.trim().length > 0 ? { t: 'pre', text: raw } : null;
}

/** Coleta runs inline, quebrando em blocos `img`/`pre` e preservando separação em blocos aninhados. */
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

  if (tag === 'pre') {
    flushText();
    const pre = buildPreBlock(el);
    if (pre) out.push(pre);
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

  const isBlockSep = INLINE_BLOCK_SEPARATORS.has(tag);
  const isSpaceSep = INLINE_SPACE_SEPARATORS.has(tag);
  if (isBlockSep) pushSeparator(runs, '\n');
  else if (isSpaceSep) pushSeparator(runs, ' ');

  const childStyle = nextStyle(tag, style);
  for (let i = 0; i < el.childNodes.length; i++) {
    collectInline(el.childNodes[i], childStyle, runs, out, flushText, opts);
  }

  if (isBlockSep) pushSeparator(runs, '\n');
  else if (isSpaceSep) pushSeparator(runs, ' ');
}

function collectPlainRuns(
  node: Node,
  style: InlineStyle,
  runs: Run[],
  images?: Block[],
  altTexts?: string[],
  opts: HtmlBlocksOptions = {},
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
    const alt = el.getAttribute('alt')?.trim();
    if (alt && altTexts) altTexts.push(alt);
    if (images) {
      const img = buildImgBlock(
        el.getAttribute('src'),
        el.getAttribute('alt'),
        el.getAttribute('width'),
        el.getAttribute('height'),
        opts,
      );
      if (img) images.push(img);
    }
    return;
  }

  if (tag === 'svg') {
    if (images) {
      images.push(...extractImageFromSvg(el, opts));
    }
    return;
  }

  const childStyle = nextStyle(tag, style);
  const isBlockBoundary = PLAIN_BOUNDARY_TAGS.has(tag);
  const isSpaceBoundary = PLAIN_SPACE_TAGS.has(tag);
  if (isBlockBoundary) {
    pushSeparator(runs, '\n');
  } else if (isSpaceBoundary) {
    pushSeparator(runs, ' ');
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    collectPlainRuns(el.childNodes[i], childStyle, runs, images, altTexts, opts);
  }
  if (isBlockBoundary) {
    pushSeparator(runs, '\n');
  } else if (isSpaceBoundary) {
    pushSeparator(runs, ' ');
  }
}

function belongsToTable(el: Element, table: Element): boolean {
  let parent: Element | null = el.parentElement;
  while (parent && parent !== table && tagName(parent) !== 'table') {
    parent = parent.parentElement;
  }
  return parent === table;
}

function processTable(table: Element, out: Block[], opts: HtmlBlocksOptions): void {
  // Preserva <caption> direta desta tabela (sem duplicar legendas de tabelas aninhadas)
  const captions = table.getElementsByTagName('caption');
  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    if (!belongsToTable(cap, table)) continue;
    let capRuns: Run[] = [];
    const flushCap = () => {
      const res = finalizeRuns(capRuns);
      capRuns = [];
      if (res) {
        out.push(res.runs ? { t: 'p', text: res.text, runs: res.runs } : { t: 'p', text: res.text });
      }
    };
    for (let c = 0; c < cap.childNodes.length; c++) {
      collectInline(cap.childNodes[c], {}, capRuns, out, flushCap, opts);
    }
    flushCap();
  }

  const rows = table.getElementsByTagName('tr');
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!belongsToTable(row, table)) continue;

    const rowRuns: Run[] = [];
    const rowImages: Block[] = [];
    let hasCell = false;
    for (let c = 0; c < row.children.length; c++) {
      const cell = row.children[c];
      const cellTag = tagName(cell);
      if (cellTag !== 'td' && cellTag !== 'th') continue;

      const cellRuns: Run[] = [];
      collectPlainRuns(cell, {}, cellRuns, rowImages, undefined, opts);
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
    if (rowImages.length > 0) {
      out.push(...rowImages);
    }
  }
}

function hasDirectLiChild(el: Element): boolean {
  for (let i = 0; i < el.children.length; i++) {
    if (tagName(el.children[i]) === 'li') return true;
  }
  return false;
}

function hasDescendantInSet(el: Element, tags: Set<string>): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (tags.has(tagName(child)) || hasDescendantInSet(child, tags)) return true;
  }
  return false;
}

function processList(listEl: Element, ordered: boolean, out: Block[], opts: HtmlBlocksOptions): void {
  let looseRuns: Run[] = [];
  const flushLoose = () => {
    const res = finalizeRuns(looseRuns);
    looseRuns = [];
    if (res) {
      out.push(res.runs ? { t: 'p', text: res.text, runs: res.runs } : { t: 'p', text: res.text });
    }
  };

  for (let i = 0; i < listEl.childNodes.length; i++) {
    const child = listEl.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      const tag = tagName(el);
      if (IGNORED_TAGS.has(tag)) continue;
      if (tag === 'li') {
        flushLoose();
        processListItem(el, ordered, out, opts);
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flushLoose();
        processList(el, tag === 'ol', out, opts);
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        flushLoose();
        if (tag === 'div' && hasDirectLiChild(el)) {
          processList(el, ordered, out, opts);
        } else {
          processBlockElement(el, out, opts);
        }
        continue;
      }
    }
    collectInline(child, {}, looseRuns, out, flushLoose, opts);
  }
  flushLoose();
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
      if (IGNORED_TAGS.has(tag)) continue;
      if (tag === 'ul' || tag === 'ol') {
        flushLi();
        processList(el, tag === 'ol', out, opts);
        continue;
      }
      if (LIST_DELEGATE_TAGS.has(tag)) {
        flushLi();
        processBlockElement(el, out, opts);
        continue;
      }
      if ((tag === 'div' || tag === 'section' || tag === 'article' || tag === 'figure') && hasDescendantInSet(el, CONTAINER_DELEGATE_TRIGGERS)) {
        flushLi();
        processBlockElement(el, out, opts);
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
    const imgs: Block[] = [];
    const alts: string[] = [];
    collectPlainRuns(el, {}, runs, imgs, alts, opts);
    const res = finalizeRuns(runs);
    const headingText = res?.text || alts.join(' ').trim();
    if (headingText) out.push({ t: 'h', level: headingLevel, text: headingText });
    if (imgs.length > 0) out.push(...imgs);
    return;
  }

  if (tag === 'pre') {
    const pre = buildPreBlock(el);
    if (pre) out.push(pre);
    return;
  }

  if (tag === 'blockquote') {
    let runs: Run[] = [];
    const flushQuote = () => {
      const res = finalizeRuns(runs);
      runs = [];
      if (res) {
        out.push(res.runs ? { t: 'quote', text: res.text, runs: res.runs } : { t: 'quote', text: res.text });
      }
    };
    for (let i = 0; i < el.childNodes.length; i++) {
      collectInline(el.childNodes[i], {}, runs, out, flushQuote, opts);
    }
    flushQuote();
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
    processTable(el, out, opts);
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
  if (tagName(root) === 'svg') {
    blocks.push(...extractImageFromSvg(root, opts));
    if (blocks.length === 0) {
      processContainer(root, blocks, opts);
    }
    return blocks;
  }
  processContainer(root, blocks, opts);
  return blocks;
}
