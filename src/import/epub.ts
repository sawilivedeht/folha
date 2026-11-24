import { unzipSync } from 'fflate';
import type { Chapter, ParsedBook, ProgressFn } from '../types';
import { htmlToBlocks } from './html-blocks';

export interface ManifestItem {
  id: string;
  href: string; // caminho normalizado dentro do zip
  mediaType: string;
  properties: string[];
}

export interface SpineItem {
  idref: string;
  linear: boolean;
}

export interface OpfData {
  title?: string;
  author?: string;
  lang?: string;
  coverId?: string;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  tocId?: string;
  prePaginated?: boolean;
}

/** Limites de conteúdo descompactado (proteção contra "bombas de zip" que esgotam a memória do aparelho). */
export const MAX_EPUB_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_EPUB_TOTAL_BYTES = 512 * 1024 * 1024;

/** Dimensão máxima (largura ou altura) ao rasterizar um SVG do EPUB para PNG. */
const MAX_SVG_RASTER_DIM = 2048;

class EpubTooLargeError extends Error {}

export interface ParseEpubOptions {
  /** Parser injetável de XHTML/HTML (padrão: `DOMParser` do navegador). */
  parseDocument?: (html: string) => Document;
  /** Rasterizador injetável de SVG para PNG (padrão: `Image` + `canvas` no navegador). */
  rasterizeSvg?: (bytes: Uint8Array) => Promise<Blob | null>;
}

/** Extensões que o leitor nunca usa e não precisam ser descompactadas em memória. */
const IGNORED_ZIP_EXTS = new Set([
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'wav',
  'flac',
  'opus',
  'mp4',
  'm4v',
  'webm',
  'ogv',
  'mov',
  'avi',
  'mkv',
  'css',
  'js',
  'mjs',
  'cjs',
  'map',
]);

/** Indica se uma entrada do ZIP (fontes, áudio, vídeo, CSS, JS ou diretório) deve ser ignorada na descompactação. */
export function isIgnoredZipEntry(name: string): boolean {
  if (name.endsWith('/')) return true;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash === -1 ? name : name.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return IGNORED_ZIP_EXTS.has(ext);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  ncx: 'application/x-dtbncx+xml',
  opf: 'application/oebps-package+xml',
};

export function mimeFromPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = clean.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function resolveSegments(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function cleanAndDecodeHref(raw: string): string {
  const withoutHash = raw.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    // Mantém original se houver `%` inválido
    return withoutHash;
  }
}

/** Normaliza um caminho interno do zip (decodifica URI, resolve `.` e `..`, remove `/` inicial e `#fragment`). */
export function normalizeZipPath(rawPath: string): string {
  return resolveSegments(cleanAndDecodeHref(rawPath));
}

/** Resolve um `href` relativo ao arquivo `baseFilePath` dentro do zip (sem re-decodificar `baseFilePath`). */
export function resolveRelativePath(baseFilePath: string, relativeHref: string): string {
  const cleanHref = relativeHref.trim();
  if (cleanHref.startsWith('/')) {
    return normalizeZipPath(cleanHref);
  }
  const decodedHref = cleanAndDecodeHref(cleanHref);
  const normBase = resolveSegments(baseFilePath.replace(/\\/g, '/'));
  const slash = normBase.lastIndexOf('/');
  const baseDir = slash === -1 ? '' : normBase.slice(0, slash + 1);
  return resolveSegments(baseDir + decodedHref);
}

/**
 * Decodifica bytes de XML/XHTML detectando BOM UTF-8/UTF-16, UTF-16 sem BOM,
 * prólogo `encoding="..."` ou `<meta charset="...">`, e caindo de UTF-8 estrito para windows-1252.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // Auto-detecção XML 1.0 para UTF-16 sem BOM (`<?` ou `<x`)
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] !== 0x00 && bytes[3] === 0x00) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] !== 0x00) {
    return new TextDecoder('utf-16be').decode(bytes);
  }

  const headLen = Math.min(bytes.length, 1024);
  let head = '';
  for (let i = 0; i < headLen; i++) {
    head += String.fromCharCode(bytes[i]);
  }
  const xmlEnc = /^\s*<\?xml\b[^<>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  const metaEnc = /<meta\b[^<>]*\bcharset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i.exec(head)?.[1];
  const declared = (xmlEnc ?? metaEnc)?.trim().toLowerCase();

  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // Rótulo desconhecido: segue para UTF-8 estrito com fallback windows-1252
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function safeCodePoint(cp: number, fallback: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return fallback;
  }
  return String.fromCodePoint(cp);
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  sbquo: '\u201a',
  bdquo: '\u201e',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  sect: '\u00a7',
  para: '\u00b6',
  deg: '\u00b0',
  ordm: '\u00ba',
  ordf: '\u00aa',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  aacute: '\u00e1',
  Aacute: '\u00c1',
  agrave: '\u00e0',
  Agrave: '\u00c0',
  acirc: '\u00e2',
  Acirc: '\u00c2',
  atilde: '\u00e3',
  Atilde: '\u00c3',
  auml: '\u00e4',
  Auml: '\u00c4',
  aring: '\u00e5',
  Aring: '\u00c5',
  aelig: '\u00e6',
  AElig: '\u00c6',
  ccedil: '\u00e7',
  Ccedil: '\u00c7',
  eacute: '\u00e9',
  Eacute: '\u00c9',
  egrave: '\u00e8',
  Egrave: '\u00c8',
  ecirc: '\u00ea',
  Ecirc: '\u00ca',
  euml: '\u00eb',
  Euml: '\u00cb',
  iacute: '\u00ed',
  Iacute: '\u00cd',
  igrave: '\u00ec',
  Igrave: '\u00cc',
  icirc: '\u00ee',
  Icirc: '\u00ce',
  iuml: '\u00ef',
  Iuml: '\u00cf',
  ntilde: '\u00f1',
  Ntilde: '\u00d1',
  oacute: '\u00f3',
  Oacute: '\u00d3',
  ograve: '\u00f2',
  Ograve: '\u00d2',
  ocirc: '\u00f4',
  Ocirc: '\u00d4',
  otilde: '\u00f5',
  Otilde: '\u00d5',
  ouml: '\u00f6',
  Ouml: '\u00d6',
  oslash: '\u00f8',
  Oslash: '\u00d8',
  oelig: '\u0153',
  OElig: '\u0152',
  uacute: '\u00fa',
  Uacute: '\u00da',
  ugrave: '\u00f9',
  Ugrave: '\u00d9',
  ucirc: '\u00fb',
  Ucirc: '\u00db',
  uuml: '\u00fc',
  Uuml: '\u00dc',
  yacute: '\u00fd',
  Yacute: '\u00dd',
  yuml: '\u00ff',
  Yuml: '\u0178',
  szlig: '\u00df',
  eth: '\u00f0',
  ETH: '\u00d0',
  thorn: '\u00fe',
  THORN: '\u00de',
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) => safeCodePoint(Number.parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => safeCodePoint(Number.parseInt(dec, 10), m))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeHtmlEntities(text: string): string {
  const withNamed = text.replace(/&([a-zA-Z]+);/g, (m, name: string) => HTML_NAMED_ENTITIES[name] ?? m);
  return decodeXmlEntities(withNamed);
}

/** Remove comentários XML e escapa conteúdo de blocos `<![CDATA[...]]>` em uma única passagem linear O(N). */
function preprocessXml(xml: string): string {
  if (xml.indexOf('<!--') === -1 && xml.indexOf('<![CDATA[') === -1) {
    return xml;
  }
  const parts: string[] = [];
  let pos = 0;
  while (pos < xml.length) {
    const cStart = xml.indexOf('<!--', pos);
    const dStart = xml.indexOf('<![CDATA[', pos);
    if (cStart === -1 && dStart === -1) {
      parts.push(xml.slice(pos));
      break;
    }
    if (cStart !== -1 && (dStart === -1 || cStart < dStart)) {
      parts.push(xml.slice(pos, cStart));
      const cEnd = xml.indexOf('-->', cStart + 4);
      if (cEnd === -1) break;
      pos = cEnd + 3;
    } else {
      parts.push(xml.slice(pos, dStart));
      const dEnd = xml.indexOf(']]>', dStart + 9);
      const raw = dEnd === -1 ? xml.slice(dStart + 9) : xml.slice(dStart + 9, dEnd);
      parts.push(raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      if (dEnd === -1) break;
      pos = dEnd + 3;
    }
  }
  return parts.join('');
}

function stripTags(html: string): string {
  return decodeXmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function stripHtmlTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseAttrs(tagAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagAttrs)) !== null) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

interface TagMatch {
  attrs: string;
  inner: string;
}

/**
 * Localiza elementos `<[prefix:]localName ...>...</[prefix:]localName>` em tempo linear O(N).
 * Ignora tags autofechadas (`<tag/>`) e evita busca quadrática quando há milhares de aberturas sem fechamento.
 */
function findTagElements(xml: string, localName: string): TagMatch[] {
  const results: TagMatch[] = [];
  const openRe = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b([^<>]*)>`, 'gi');
  const closeRe = new RegExp(`<\\/(?:[a-zA-Z0-9_-]+:)?${localName}\\s*>`, 'gi');

  let pos = 0;
  while (pos < xml.length) {
    openRe.lastIndex = pos;
    const open = openRe.exec(xml);
    if (!open) break;

    const rawAttrs = open[1];
    const openEnd = open.index + open[0].length;
    if (rawAttrs.trimEnd().endsWith('/')) {
      pos = openEnd;
      continue;
    }

    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(xml);
    if (!close) break;

    results.push({
      attrs: rawAttrs,
      inner: xml.slice(openEnd, close.index),
    });
    pos = close.index + close[0].length;
  }
  return results;
}

/** Lê `META-INF/container.xml` e devolve o caminho normalizado do arquivo OPF. */
export function parseContainerXml(xml: string): string | null {
  const clean = preprocessXml(xml);
  const re = /<(?:[a-zA-Z0-9_-]+:)?rootfile\b([^<>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const attrs = parseAttrs(m[1]);
    if (attrs['full-path']) {
      return normalizeZipPath(attrs['full-path']);
    }
  }
  return null;
}

function extractFirstTagText(xml: string, localNames: string[]): string | undefined {
  for (const name of localNames) {
    for (const match of findTagElements(xml, name)) {
      const text = stripTags(match.inner);
      if (text) return text;
    }
  }
  return undefined;
}

/** Analisa o arquivo OPF (metadados, manifest, spine e capa). */
export function parseOpf(xml: string, opfPath: string): OpfData {
  const clean = preprocessXml(xml);
  const title = extractFirstTagText(clean, ['title']);
  const author = extractFirstTagText(clean, ['creator']);
  const lang = extractFirstTagText(clean, ['language']);

  let coverId: string | undefined;
  const metaRe = /<(?:[a-zA-Z0-9_-]+:)?meta\b([^<>]*)\/?>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(clean)) !== null) {
    const attrs = parseAttrs(mm[1]);
    if (attrs.name?.toLowerCase() === 'cover' && attrs.content) {
      coverId = attrs.content.trim();
      break;
    }
  }

  let prePaginated = false;
  for (const meta of findTagElements(clean, 'meta')) {
    const attrs = parseAttrs(meta.attrs);
    if (
      attrs.property?.trim().toLowerCase() === 'rendition:layout' &&
      stripTags(meta.inner).toLowerCase() === 'pre-paginated'
    ) {
      prePaginated = true;
      break;
    }
  }

  const manifest = new Map<string, ManifestItem>();
  const itemRe = /<(?:[a-zA-Z0-9_-]+:)?item\b([^<>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(clean)) !== null) {
    const attrs = parseAttrs(im[1]);
    if (!attrs.id || !attrs.href) continue;
    const href = resolveRelativePath(opfPath, attrs.href);
    const mediaType = (attrs['media-type'] ?? mimeFromPath(href)).toLowerCase();
    const properties = attrs.properties ? attrs.properties.trim().split(/\s+/) : [];
    manifest.set(attrs.id, { id: attrs.id, href, mediaType, properties });
  }

  let tocId: string | undefined;
  const spineMatch = /<(?:[a-zA-Z0-9_-]+:)?spine\b([^<>]*)>/i.exec(clean);
  if (spineMatch) {
    const spineAttrs = parseAttrs(spineMatch[1]);
    if (spineAttrs.toc) tocId = spineAttrs.toc;
  }

  const spine: SpineItem[] = [];
  const itemrefRe = /<(?:[a-zA-Z0-9_-]+:)?itemref\b([^<>]*)\/?>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = itemrefRe.exec(clean)) !== null) {
    const attrs = parseAttrs(rm[1]);
    if (!attrs.idref) continue;
    if (attrs.properties) {
      const refProps = attrs.properties.trim().split(/\s+/);
      if (refProps.some((p) => p.toLowerCase() === 'rendition:layout-pre-paginated')) {
        prePaginated = true;
      }
    }
    spine.push({
      idref: attrs.idref,
      linear: attrs.linear?.toLowerCase() !== 'no',
    });
  }

  return {
    title,
    author,
    lang,
    coverId,
    manifest,
    spine,
    tocId,
    ...(prePaginated ? { prePaginated: true } : {}),
  };
}

/** Extrai mapa `caminhoNormalizado -> título` de um arquivo `toc.ncx` (EPUB 2). */
export function parseNcxToc(xml: string, ncxPath: string): Map<string, string> {
  const clean = preprocessXml(xml);
  const toc = new Map<string, string>();
  const openRe = /<(?:[a-zA-Z0-9_-]+:)?navPoint\b[^<>]*>/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(clean)) !== null) {
    if (m[0].endsWith('/>')) continue;
    starts.push(m.index + m[0].length);
  }

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : clean.length;
    const chunk = clean.slice(from, to);
    const labels = findTagElements(chunk, 'navLabel');
    const title = labels.length > 0 ? extractFirstTagText(labels[0].inner, ['text']) : undefined;
    const contentMatch = /<(?:[a-zA-Z0-9_-]+:)?content\b([^<>]*)\/?>/i.exec(chunk);
    if (!title || !contentMatch) continue;
    const attrs = parseAttrs(contentMatch[1]);
    if (!attrs.src) continue;
    const resolved = resolveRelativePath(ncxPath, attrs.src);
    if (!toc.has(resolved)) {
      toc.set(resolved, title);
    }
  }
  return toc;
}

/** Extrai mapa `caminhoNormalizado -> título` de um documento `nav.xhtml` (EPUB 3). */
export function parseNavToc(xhtml: string, navPath: string): Map<string, string> {
  const clean = preprocessXml(xhtml);
  const toc = new Map<string, string>();
  const navs = findTagElements(clean, 'nav');
  let selectedBody: string | null = null;
  let firstBody: string | null = null;
  for (const nav of navs) {
    const attrs = parseAttrs(nav.attrs);
    const epubType = (attrs['epub:type'] ?? attrs.type ?? '').toLowerCase();
    if (firstBody === null) firstBody = nav.inner;
    if (epubType.split(/\s+/).includes('toc')) {
      selectedBody = nav.inner;
      break;
    }
  }
  const body = selectedBody ?? firstBody;
  if (!body) return toc;

  for (const link of findTagElements(body, 'a')) {
    const attrs = parseAttrs(link.attrs);
    if (!attrs.href) continue;
    const title = stripHtmlTags(link.inner);
    if (!title) continue;
    const resolved = resolveRelativePath(navPath, attrs.href);
    if (!toc.has(resolved)) {
      toc.set(resolved, title);
    }
  }
  return toc;
}

function expandSelfClosingRawTextTags(html: string): string {
  // Em HTML5, <title/>, <script/>, <style/>, <noscript/> e <textarea/> não se fecham e engolem o resto do documento.
  return html.replace(/<(title|script|style|noscript|textarea)\b([^<>]*)\/>/gi, '<$1$2></$1>');
}

function defaultParseDocument(html: string): Document {
  const parser = new DOMParser();
  const xhtml = parser.parseFromString(html, 'application/xhtml+xml');
  if (
    xhtml.getElementsByTagNameNS('*', 'parsererror').length === 0 &&
    xhtml.getElementsByTagName('parsererror').length === 0
  ) {
    return xhtml;
  }
  return parser.parseFromString(expandSelfClosingRawTextTags(html), 'text/html');
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sample = decodeXmlBytes(bytes.subarray(0, Math.min(bytes.length, 2048)));
  const stripped = preprocessXml(sample).trimStart();
  return /^(?:<\?xml\b[\s\S]*?\?>\s*)?(?:<!DOCTYPE\s+svg\b[^>]*>\s*)?<(?:[a-zA-Z0-9_-]+:)?svg\b/i.test(stripped);
}

/** Confirma o tipo de imagem pelos bytes iniciais (PNG, JPEG, GIF, WebP ou SVG); nunca confia no nome do arquivo. */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (looksLikeSvg(bytes)) {
    return 'image/svg+xml';
  }
  return null;
}

const SVG_STRIP_TAGS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'image',
  'feimage',
]);

function parseSvgDimension(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseSvgViewBox(svg: Element): { w: number; h: number } | null {
  const vb = svg.getAttribute('viewBox');
  if (!vb) return null;
  const nums = vb.trim().split(/[\s,]+/).map(Number);
  if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
    return { w: nums[2], h: nums[3] };
  }
  return null;
}

function clampSvgSize(w: number, h: number): { w: number; h: number } {
  let width = Number.isFinite(w) && w > 0 ? w : 600;
  let height = Number.isFinite(h) && h > 0 ? h : 600;
  const maxSide = Math.max(width, height);
  if (maxSide > MAX_SVG_RASTER_DIM) {
    const scale = MAX_SVG_RASTER_DIM / maxSide;
    width *= scale;
    height *= scale;
  }
  return {
    w: Math.max(1, Math.round(width)),
    h: Math.max(1, Math.round(height)),
  };
}

function localTagName(el: Element): string {
  const raw = (el.localName || el.tagName).toLowerCase();
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
}

function sanitizeSvgForRaster(svgBytes: Uint8Array): { svgText: string; w: number; h: number } | null {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(decodeXmlBytes(svgBytes), 'image/svg+xml');
  if (
    doc.getElementsByTagNameNS('*', 'parsererror').length > 0 ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    return null;
  }
  const root = doc.documentElement;
  if (!root || localTagName(root) !== 'svg') {
    return null;
  }

  // Remove elementos ativos/externos e <foreignObject> (que contamina o canvas e impede toBlob no Chromium)
  const toRemove: Element[] = [];
  const descendants = root.getElementsByTagName('*');
  for (let i = 0; i < descendants.length; i++) {
    const el = descendants[i];
    if (SVG_STRIP_TAGS.has(localTagName(el))) {
      toRemove.push(el);
    }
  }
  for (const el of toRemove) {
    el.parentNode?.removeChild(el);
  }

  const cleanElement = (el: Element): void => {
    const tag = localTagName(el);
    if (tag === 'style' && el.textContent) {
      el.textContent = el.textContent
        .replace(/@import\b[^;]*(?:;|$)/gi, '')
        .replace(/url\(\s*["']?\s*(?:https?:|\/\/|data:|javascript:)[^)]*\)/gi, 'none');
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      const remove = (): void => {
        if (attr.namespaceURI) {
          el.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          el.removeAttribute(attr.name);
        }
      };
      if (name.startsWith('on')) {
        remove();
      } else if (/^(?:href|xlink:href|src|action|formaction)$/.test(name)) {
        if (/^(?:javascript:|https?:|\/\/|data:)/i.test(val)) {
          remove();
        }
      } else if (name === 'style' && /url\(|expression\(|@import/i.test(val)) {
        remove();
      }
    }
  };
  cleanElement(root);
  const remaining = root.getElementsByTagName('*');
  for (let i = 0; i < remaining.length; i++) {
    cleanElement(remaining[i]);
  }

  const vb = parseSvgViewBox(root);
  const attrW = parseSvgDimension(root.getAttribute('width'));
  const attrH = parseSvgDimension(root.getAttribute('height'));
  const target = clampSvgSize(attrW ?? vb?.w ?? 600, attrH ?? vb?.h ?? 600);
  root.setAttribute('width', String(target.w));
  root.setAttribute('height', String(target.h));
  if (!root.getAttribute('xmlns')) {
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  return {
    svgText: new XMLSerializer().serializeToString(doc),
    w: target.w,
    h: target.h,
  };
}

/** Rasteriza um SVG para PNG via Image + canvas para evitar executar `<script>` se o blob for aberto em nova aba. */
async function defaultRasterizeSvg(svgBytes: Uint8Array): Promise<Blob | null> {
  if (
    typeof document === 'undefined' ||
    typeof Image === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const sanitized = sanitizeSvgForRaster(svgBytes);
  if (!sanitized) return null;

  const svgBlob = new Blob([sanitized.svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return null;

    const { w, h } = clampSvgSize(img.naturalWidth || sanitized.w, img.naturalHeight || sanitized.h);
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      } catch {
        resolve(null);
      }
    });
    return pngBlob && pngBlob.size > 0 ? pngBlob : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildZipIndex(files: Record<string, Uint8Array>): {
  exact: Map<string, Uint8Array>;
  lower: Map<string, Uint8Array>;
} {
  const exact = new Map<string, Uint8Array>();
  const lower = new Map<string, Uint8Array>();
  for (const [rawKey, bytes] of Object.entries(files)) {
    const norm = resolveSegments(rawKey.replace(/\\/g, '/'));
    exact.set(norm, bytes);
    const low = norm.toLowerCase();
    if (!lower.has(low)) {
      lower.set(low, bytes);
    }
  }
  return { exact, lower };
}

function lookupZip(
  index: { exact: Map<string, Uint8Array>; lower: Map<string, Uint8Array> },
  targetPath: string,
): Uint8Array | undefined {
  const direct = index.exact.get(targetPath);
  if (direct) return direct;
  const norm = resolveSegments(targetPath.replace(/\\/g, '/'));
  return index.exact.get(norm) ?? index.lower.get(norm.toLowerCase());
}

function toBlob(bytes: Uint8Array, mime: string): Blob {
  // Cópia garante ArrayBuffer padrão (compatível com BlobPart em TypeScript estrito)
  return new Blob([bytes.slice()], { type: mime });
}

function fallbackTitleFromFile(fileName: string): string {
  return fileName.replace(/\.epub$/i, '').trim() || 'Sem título';
}

/** Importa um arquivo EPUB (2 ou 3) em `ParsedBook`. */
export async function parseEpub(
  data: ArrayBuffer,
  fileName: string,
  onProgress: ProgressFn,
  options: ParseEpubOptions = {},
): Promise<ParsedBook> {
  onProgress(0, 'Descompactando EPUB...');
  let files: Record<string, Uint8Array>;
  let totalBytes = 0;
  try {
    files = unzipSync(new Uint8Array(data), {
      filter: (info) => {
        if (isIgnoredZipEntry(info.name)) return false;
        totalBytes += info.originalSize;
        if (info.originalSize > MAX_EPUB_ENTRY_BYTES || totalBytes > MAX_EPUB_TOTAL_BYTES) {
          throw new EpubTooLargeError('limite de tamanho');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof EpubTooLargeError) {
      throw new Error('EPUB grande demais para abrir: o conteúdo descompactado passa de 512 MB.');
    }
    throw new Error('EPUB inválido: o arquivo está corrompido ou incompleto (não foi possível descompactar).');
  }

  const zipIndex = buildZipIndex(files);

  const containerBytes = lookupZip(zipIndex, 'META-INF/container.xml');
  if (!containerBytes) {
    throw new Error('EPUB inválido: META-INF/container.xml não encontrado.');
  }

  const opfPath = parseContainerXml(decodeXmlBytes(containerBytes));
  if (!opfPath) {
    throw new Error('EPUB inválido: arquivo OPF não encontrado em container.xml.');
  }

  const opfBytes = lookupZip(zipIndex, opfPath);
  if (!opfBytes) {
    throw new Error(`EPUB inválido: OPF "${opfPath}" ausente no arquivo.`);
  }

  const opf = parseOpf(decodeXmlBytes(opfBytes), opfPath);

  // Sumário: prioriza nav.xhtml (EPUB 3), senão toc.ncx (EPUB 2)
  let tocTitles = new Map<string, string>();
  for (const item of opf.manifest.values()) {
    if (item.properties.includes('nav')) {
      const navBytes = lookupZip(zipIndex, item.href);
      if (navBytes) {
        tocTitles = parseNavToc(decodeXmlBytes(navBytes), item.href);
        if (tocTitles.size > 0) break;
      }
    }
  }
  if (tocTitles.size === 0) {
    const ncxItem =
      (opf.tocId ? opf.manifest.get(opf.tocId) : undefined) ??
      Array.from(opf.manifest.values()).find((it) => it.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxBytes = lookupZip(zipIndex, ncxItem.href);
      if (ncxBytes) {
        tocTitles = parseNcxToc(decodeXmlBytes(ncxBytes), ncxItem.href);
      }
    }
  }

  const tocTitlesLower = new Map<string, string>();
  for (const [k, v] of tocTitles) {
    const low = k.toLowerCase();
    if (!tocTitlesLower.has(low)) tocTitlesLower.set(low, v);
  }

  // Mapa de mídia indexado em minúsculas para consistência com lookup case-insensitive do ZIP
  const manifestByPath = new Map<string, ManifestItem>();
  for (const item of opf.manifest.values()) {
    const low = item.href.toLowerCase();
    if (!manifestByPath.has(low)) {
      manifestByPath.set(low, item);
    }
  }

  const rasterizeSvg = options.rasterizeSvg ?? defaultRasterizeSvg;
  const warnings: string[] = [];
  let svgDiscardedCount = 0;

  // Capa via manifest (properties="cover-image" ou meta name="cover")
  let cover: Blob | undefined;
  const coverItem =
    Array.from(opf.manifest.values()).find((it) => it.properties.includes('cover-image')) ??
    (opf.coverId ? opf.manifest.get(opf.coverId) : undefined) ??
    (opf.coverId ? manifestByPath.get(resolveRelativePath(opfPath, opf.coverId).toLowerCase()) : undefined);

  if (coverItem) {
    const coverBytes = lookupZip(zipIndex, coverItem.href);
    if (coverBytes) {
      const detected = detectImageMime(coverBytes);
      if (detected === 'image/svg+xml') {
        const pngCover = await rasterizeSvg(coverBytes);
        if (pngCover && pngCover.size > 0) {
          cover = pngCover;
        } else {
          svgDiscardedCount++;
        }
      } else if (detected) {
        cover = toBlob(coverBytes, detected);
      }
    }
  }

  const images = new Map<string, Blob>();
  const pathToKey = new Map<string, string>();
  const rejectedPaths = new Set<string>();
  const usedKeys = new Set<string>();
  const pendingSvg = new Map<string, { bytes: Uint8Array; lowerPath: string }>();

  const registerImage = (resolvedZipPath: string): string | undefined => {
    const lowerPath = resolvedZipPath.toLowerCase();
    if (rejectedPaths.has(lowerPath)) return undefined;

    const existing = pathToKey.get(lowerPath);
    if (existing) return existing;

    const imgBytes = lookupZip(zipIndex, resolvedZipPath);
    if (!imgBytes) return undefined;

    const detected = detectImageMime(imgBytes);
    if (!detected) {
      rejectedPaths.add(lowerPath);
      return undefined;
    }

    const baseKey = resolvedZipPath.replace(/\//g, '_') || 'img';
    let key = baseKey;
    let suffix = 1;
    while (usedKeys.has(key)) {
      key = `${suffix++}_${baseKey}`;
    }
    usedKeys.add(key);
    pathToKey.set(lowerPath, key);

    if (detected === 'image/svg+xml') {
      pendingSvg.set(key, { bytes: imgBytes, lowerPath });
    } else {
      images.set(key, toBlob(imgBytes, detected));
    }
    return key;
  };

  const parseDoc = options.parseDocument ?? defaultParseDocument;
  const chapters: Chapter[] = [];
  const total = opf.spine.length;

  for (let i = 0; i < total; i++) {
    onProgress(total > 0 ? i / total : 0, `Lendo capítulo ${i + 1} de ${total}...`);
    const ref = opf.spine[i];
    const item = opf.manifest.get(ref.idref);
    if (!item) continue;

    const itemBytes = lookupZip(zipIndex, item.href);
    if (!itemBytes) continue;

    const html = decodeXmlBytes(itemBytes);
    const doc = parseDoc(html);
    const blocks = htmlToBlocks(doc, {
      resolveImage: (rawSrc) => {
        if (/^(?:data:|https?:|blob:|\/\/)/i.test(rawSrc)) return undefined;
        const resolved = resolveRelativePath(item.href, rawSrc);
        return registerImage(resolved);
      },
    });

    const failedKeys = new Set<string>();
    if (pendingSvg.size > 0) {
      for (const [key, entry] of pendingSvg) {
        const pngBlob = await rasterizeSvg(entry.bytes);
        if (pngBlob && pngBlob.size > 0) {
          images.set(key, pngBlob);
        } else {
          failedKeys.add(key);
          rejectedPaths.add(entry.lowerPath);
          pathToKey.delete(entry.lowerPath);
          svgDiscardedCount++;
        }
      }
      pendingSvg.clear();
    }

    const finalBlocks =
      failedKeys.size > 0 ? blocks.filter((b) => b.t !== 'img' || !failedKeys.has(b.src)) : blocks;

    if (finalBlocks.length === 0) continue;

    const tocTitle = tocTitles.get(item.href) ?? tocTitlesLower.get(item.href.toLowerCase());
    const headingBlock =
      finalBlocks.find((b) => b.t === 'h' && (b.level === 1 || b.level === 2)) ??
      finalBlocks.find((b) => b.t === 'h');
    const chapterTitle =
      tocTitle || (headingBlock && headingBlock.t === 'h' ? headingBlock.text : `Capítulo ${chapters.length + 1}`);

    chapters.push({ title: chapterTitle, blocks: finalBlocks });
  }

  // Fallback de capa: primeira imagem do primeiro capítulo que tiver imagem
  if (!cover && chapters.length > 0) {
    for (const b of chapters[0].blocks) {
      if (b.t === 'img') {
        cover = images.get(b.src);
        if (cover) break;
      }
    }
  }

  if (svgDiscardedCount > 0) {
    warnings.push(
      svgDiscardedCount === 1
        ? '1 imagem SVG não pôde ser convertida e foi ignorada.'
        : `${svgDiscardedCount} imagens SVG não puderam ser convertidas e foram ignoradas.`,
    );
  }

  const hasTextBlocks = chapters.some((ch) =>
    ch.blocks.some((b) => b.t !== 'img' && b.t !== 'hr' && b.text.trim().length > 0),
  );
  if (opf.prePaginated && hasTextBlocks) {
    warnings.push(
      'Este EPUB usa layout fixo (pre-paginated): o posicionamento original das páginas pode não ser preservado.',
    );
  }

  onProgress(1, 'Concluído');

  return {
    title: opf.title || fallbackTitleFromFile(fileName),
    ...(opf.author ? { author: opf.author } : {}),
    ...(opf.lang ? { lang: opf.lang } : {}),
    chapters,
    images,
    ...(cover ? { cover } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
