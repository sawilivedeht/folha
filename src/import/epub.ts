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
}

export interface ParseEpubOptions {
  /** Parser injetável de XHTML/HTML (padrão: `DOMParser` do navegador). */
  parseDocument?: (html: string) => Document;
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

/** Normaliza um caminho interno do zip (decodifica URI, resolve `.` e `..`, remove `/` inicial e `#fragment`). */
export function normalizeZipPath(rawPath: string): string {
  const withoutHash = rawPath.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  let decoded = withoutHash;
  try {
    decoded = decodeURIComponent(withoutHash);
  } catch {
    // Mantém original se houver `%` inválido
  }
  const parts: string[] = [];
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** Resolve um `href` relativo ao arquivo `baseFilePath` dentro do zip. */
export function resolveRelativePath(baseFilePath: string, relativeHref: string): string {
  const cleanHref = relativeHref.trim();
  if (cleanHref.startsWith('/')) {
    return normalizeZipPath(cleanHref);
  }
  const normBase = normalizeZipPath(baseFilePath);
  const slash = normBase.lastIndexOf('/');
  const baseDir = slash === -1 ? '' : normBase.slice(0, slash + 1);
  return normalizeZipPath(baseDir + cleanHref);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeXmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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

/** Lê `META-INF/container.xml` e devolve o caminho normalizado do arquivo OPF. */
export function parseContainerXml(xml: string): string | null {
  const re = /<(?:[a-zA-Z0-9_-]+:)?rootfile\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    if (attrs['full-path']) {
      return normalizeZipPath(attrs['full-path']);
    }
  }
  return null;
}

function extractFirstTagText(xml: string, localNames: string[]): string | undefined {
  for (const name of localNames) {
    const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${name}>`, 'i');
    const m = re.exec(xml);
    if (m) {
      const text = stripTags(m[1]);
      if (text) return text;
    }
  }
  return undefined;
}

/** Analisa o arquivo OPF (metadados, manifest, spine e capa). */
export function parseOpf(xml: string, opfPath: string): OpfData {
  const title = extractFirstTagText(xml, ['title']);
  const author = extractFirstTagText(xml, ['creator']);
  const lang = extractFirstTagText(xml, ['language']);

  let coverId: string | undefined;
  const metaRe = /<(?:[a-zA-Z0-9_-]+:)?meta\b([^>]*)\/?>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(xml)) !== null) {
    const attrs = parseAttrs(mm[1]);
    if (attrs.name?.toLowerCase() === 'cover' && attrs.content) {
      coverId = attrs.content.trim();
      break;
    }
  }

  const manifest = new Map<string, ManifestItem>();
  const itemRe = /<(?:[a-zA-Z0-9_-]+:)?item\b([^>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(xml)) !== null) {
    const attrs = parseAttrs(im[1]);
    if (!attrs.id || !attrs.href) continue;
    const href = resolveRelativePath(opfPath, attrs.href);
    const mediaType = (attrs['media-type'] ?? mimeFromPath(href)).toLowerCase();
    const properties = attrs.properties ? attrs.properties.trim().split(/\s+/) : [];
    manifest.set(attrs.id, { id: attrs.id, href, mediaType, properties });
  }

  let tocId: string | undefined;
  const spineMatch = /<(?:[a-zA-Z0-9_-]+:)?spine\b([^>]*)>/i.exec(xml);
  if (spineMatch) {
    const spineAttrs = parseAttrs(spineMatch[1]);
    if (spineAttrs.toc) tocId = spineAttrs.toc;
  }

  const spine: SpineItem[] = [];
  const itemrefRe = /<(?:[a-zA-Z0-9_-]+:)?itemref\b([^>]*)\/?>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = itemrefRe.exec(xml)) !== null) {
    const attrs = parseAttrs(rm[1]);
    if (!attrs.idref) continue;
    spine.push({
      idref: attrs.idref,
      linear: attrs.linear?.toLowerCase() !== 'no',
    });
  }

  return { title, author, lang, coverId, manifest, spine, tocId };
}

/** Extrai mapa `caminhoNormalizado -> título` de um arquivo `toc.ncx` (EPUB 2). */
export function parseNcxToc(xml: string, ncxPath: string): Map<string, string> {
  const toc = new Map<string, string>();
  const navPointRe = /<(?:[a-zA-Z0-9_-]+:)?navPoint\b[^>]*>([\s\S]*?)(?=<(?:[a-zA-Z0-9_-]+:)?navPoint\b|<\/(?:[a-zA-Z0-9_-]+:)?navMap>)/gi;
  let m: RegExpExecArray | null;
  while ((m = navPointRe.exec(xml)) !== null) {
    const chunk = m[1];
    const labelMatch = /<(?:[a-zA-Z0-9_-]+:)?navLabel\b[^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?text\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?text>/i.exec(chunk);
    const contentMatch = /<(?:[a-zA-Z0-9_-]+:)?content\b([^>]*)\/?>/i.exec(chunk);
    if (!labelMatch || !contentMatch) continue;
    const title = stripTags(labelMatch[1]);
    const attrs = parseAttrs(contentMatch[1]);
    if (!title || !attrs.src) continue;
    const resolved = resolveRelativePath(ncxPath, attrs.src);
    if (!toc.has(resolved)) {
      toc.set(resolved, title);
    }
  }
  return toc;
}

/** Extrai mapa `caminhoNormalizado -> título` de um documento `nav.xhtml` (EPUB 3). */
export function parseNavToc(xhtml: string, navPath: string): Map<string, string> {
  const toc = new Map<string, string>();
  const navRe = /<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi;
  let selectedBody: string | null = null;
  let firstBody: string | null = null;
  let nm: RegExpExecArray | null;
  while ((nm = navRe.exec(xhtml)) !== null) {
    const attrs = parseAttrs(nm[1]);
    const epubType = (attrs['epub:type'] ?? attrs.type ?? '').toLowerCase();
    if (firstBody === null) firstBody = nm[2];
    if (epubType.split(/\s+/).includes('toc')) {
      selectedBody = nm[2];
      break;
    }
  }
  const body = selectedBody ?? firstBody;
  if (!body) return toc;

  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(body)) !== null) {
    const attrs = parseAttrs(lm[1]);
    if (!attrs.href) continue;
    const title = stripTags(lm[2]);
    if (!title) continue;
    const resolved = resolveRelativePath(navPath, attrs.href);
    if (!toc.has(resolved)) {
      toc.set(resolved, title);
    }
  }
  return toc;
}

function defaultParseDocument(html: string): Document {
  const parser = new DOMParser();
  const xhtml = parser.parseFromString(html, 'application/xhtml+xml');
  if (xhtml.getElementsByTagName('parsererror').length === 0) {
    return xhtml;
  }
  return parser.parseFromString(html, 'text/html');
}

function findZipEntry(files: Record<string, Uint8Array>, targetPath: string): Uint8Array | undefined {
  if (files[targetPath]) return files[targetPath];
  const norm = normalizeZipPath(targetPath);
  if (files[norm]) return files[norm];
  const lower = norm.toLowerCase();
  for (const key of Object.keys(files)) {
    if (normalizeZipPath(key).toLowerCase() === lower) {
      return files[key];
    }
  }
  return undefined;
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
  const files = unzipSync(new Uint8Array(data));
  const utf8 = new TextDecoder('utf-8');

  const containerBytes = findZipEntry(files, 'META-INF/container.xml');
  if (!containerBytes) {
    throw new Error('EPUB inválido: META-INF/container.xml não encontrado.');
  }

  const opfPath = parseContainerXml(utf8.decode(containerBytes));
  if (!opfPath) {
    throw new Error('EPUB inválido: arquivo OPF não encontrado em container.xml.');
  }

  const opfBytes = findZipEntry(files, opfPath);
  if (!opfBytes) {
    throw new Error(`EPUB inválido: OPF "${opfPath}" ausente no arquivo.`);
  }

  const opf = parseOpf(utf8.decode(opfBytes), opfPath);

  // Sumário: prioriza nav.xhtml (EPUB 3), senão toc.ncx (EPUB 2)
  let tocTitles = new Map<string, string>();
  for (const item of opf.manifest.values()) {
    if (item.properties.includes('nav')) {
      const navBytes = findZipEntry(files, item.href);
      if (navBytes) {
        tocTitles = parseNavToc(utf8.decode(navBytes), item.href);
        if (tocTitles.size > 0) break;
      }
    }
  }
  if (tocTitles.size === 0) {
    const ncxItem =
      (opf.tocId ? opf.manifest.get(opf.tocId) : undefined) ??
      Array.from(opf.manifest.values()).find((it) => it.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxBytes = findZipEntry(files, ncxItem.href);
      if (ncxBytes) {
        tocTitles = parseNcxToc(utf8.decode(ncxBytes), ncxItem.href);
      }
    }
  }

  // Mapa de mídia por caminho normalizado para saber o MIME exato do manifest
  const manifestByPath = new Map<string, ManifestItem>();
  for (const item of opf.manifest.values()) {
    manifestByPath.set(item.href, item);
  }

  // Capa via manifest (properties="cover-image" ou meta name="cover")
  let cover: Blob | undefined;
  const coverItem =
    Array.from(opf.manifest.values()).find((it) => it.properties.includes('cover-image')) ??
    (opf.coverId ? opf.manifest.get(opf.coverId) : undefined) ??
    (opf.coverId ? manifestByPath.get(resolveRelativePath(opfPath, opf.coverId)) : undefined);

  if (coverItem && coverItem.mediaType.startsWith('image/')) {
    const coverBytes = findZipEntry(files, coverItem.href);
    if (coverBytes) {
      cover = toBlob(coverBytes, coverItem.mediaType);
    }
  }

  const images = new Map<string, Blob>();
  const pathToKey = new Map<string, string>();
  const usedKeys = new Set<string>();

  const registerImage = (resolvedZipPath: string): string | undefined => {
    const existing = pathToKey.get(resolvedZipPath);
    if (existing) return existing;

    const imgBytes = findZipEntry(files, resolvedZipPath);
    if (!imgBytes) return undefined;

    const baseKey = resolvedZipPath.replace(/\//g, '_') || 'img';
    let key = baseKey;
    let suffix = 1;
    while (usedKeys.has(key)) {
      key = `${suffix++}_${baseKey}`;
    }
    usedKeys.add(key);
    pathToKey.set(resolvedZipPath, key);

    const mime = manifestByPath.get(resolvedZipPath)?.mediaType ?? mimeFromPath(resolvedZipPath);
    images.set(key, toBlob(imgBytes, mime));
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

    const itemBytes = findZipEntry(files, item.href);
    if (!itemBytes) continue;

    const html = utf8.decode(itemBytes);
    const doc = parseDoc(html);
    const blocks = htmlToBlocks(doc, {
      resolveImage: (rawSrc) => {
        if (/^(?:data:|https?:|blob:)/i.test(rawSrc)) return undefined;
        const resolved = resolveRelativePath(item.href, rawSrc);
        return registerImage(resolved);
      },
    });

    if (blocks.length === 0) continue;

    const tocTitle = tocTitles.get(item.href);
    const headingBlock = blocks.find((b) => b.t === 'h' && (b.level === 1 || b.level === 2)) ?? blocks.find((b) => b.t === 'h');
    const chapterTitle = tocTitle || (headingBlock && headingBlock.t === 'h' ? headingBlock.text : `Capítulo ${chapters.length + 1}`);

    chapters.push({ title: chapterTitle, blocks });
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

  onProgress(1, 'Concluído');

  return {
    title: opf.title || fallbackTitleFromFile(fileName),
    ...(opf.author ? { author: opf.author } : {}),
    ...(opf.lang ? { lang: opf.lang } : {}),
    chapters,
    images,
    ...(cover ? { cover } : {}),
  };
}
