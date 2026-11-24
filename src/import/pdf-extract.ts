// Ponte entre o pdfjs-dist e o algoritmo puro de layout (`pdf-layout.ts`).
// Reaproveitada pelo importador do navegador (`pdf.ts`) e pelo CLI (`scripts/convert-pdf.mjs`),
// por isso não importa o pdfjs: recebe o documento/página já abertos (estruturalmente tipados).
// Mantém apenas sintaxe TypeScript apagável (compatível com `node --experimental-strip-types`).
import type { PdfOutlineEntry, PdfPageInput, PdfTextItem } from './pdf-layout';

/** Subconjunto do `PDFPageProxy` usado aqui (funciona com a build normal e a `legacy`). */
export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, { fontFamily?: string } | undefined> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  commonObjs?: { has(name: string): boolean; get(name: string): unknown };
}

/** Subconjunto do `PDFDocumentProxy` usado aqui. */
export interface PdfDocLike {
  numPages: number;
  getOutline(): Promise<unknown[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: never): Promise<number>;
  getMetadata(): Promise<{ info?: unknown }>;
}

interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineNode[];
}

/** Códigos de operador do pdfjs (`OPS`) necessários para medir imagens. */
export interface PdfOpsLike {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
}

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Sem título';
}

interface FontObjLike {
  name?: string;
  loadedName?: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Nome e estilo da fonte de um item de texto. O objeto da fonte só existe em `commonObjs` depois que o
 * pdf.js carregou a lista de operadores da página (por isso `extractPageText` deve vir depois de
 * `measurePageImageCoverage`). No pdf.js 6 o objeto não tem `name`: usa `loadedName` e as flags bold/italic.
 */
export function resolveFontInfo(
  page: PdfPageLike,
  fontName: string,
  styles: Record<string, { fontFamily?: string } | undefined>,
): { name: string; bold?: boolean; italic?: boolean } {
  try {
    if (page.commonObjs && typeof page.commonObjs.has === 'function' && page.commonObjs.has(fontName)) {
      const obj = page.commonObjs.get(fontName) as FontObjLike | undefined;
      if (obj) {
        const real = typeof obj.name === 'string' && obj.name ? obj.name : obj.loadedName;
        const family = styles[fontName]?.fontFamily;
        const name = real ? (family ? `${real} ${family}` : real) : undefined;
        if (name || obj.bold || obj.italic) {
          return {
            name: name ?? (family ? `${fontName} ${family}` : fontName),
            ...(obj.bold === true ? { bold: true } : {}),
            ...(obj.italic === true ? { italic: true } : {}),
          };
        }
      }
    }
  } catch {
    // Fonte ainda não resolvida em commonObjs; usa o nome disponível.
  }
  const family = styles[fontName]?.fontFamily;
  return { name: family ? `${fontName} ${family}` : fontName };
}

export function resolveFontName(
  page: PdfPageLike,
  fontName: string,
  styles: Record<string, { fontFamily?: string } | undefined>,
): string {
  return resolveFontInfo(page, fontName, styles).name;
}

/** Resolve o destino de um item do sumário para o número de página (1-based). */
async function resolveDestPageNumber(doc: PdfDocLike, dest: string | unknown[] | null): Promise<number | null> {
  if (!dest) return null;
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    if (typeof ref === 'number') return ref + 1;
    if (ref && typeof ref === 'object') {
      const idx = await doc.getPageIndex(ref as never);
      return idx + 1;
    }
  } catch {
    // Destino inválido ou não resolvível no PDF.
  }
  return null;
}

export async function extractOutline(doc: PdfDocLike): Promise<PdfOutlineEntry[]> {
  let rawOutline: RawOutlineNode[] | null = null;
  try {
    rawOutline = (await doc.getOutline()) as RawOutlineNode[] | null;
  } catch {
    return [];
  }
  if (!rawOutline || rawOutline.length === 0) return [];

  const entries: PdfOutlineEntry[] = [];
  const walk = async (nodes: RawOutlineNode[], level: number) => {
    for (const node of nodes) {
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (title.length > 0) {
        const pageNumber = await resolveDestPageNumber(doc, node.dest);
        if (pageNumber !== null && pageNumber >= 1 && pageNumber <= doc.numPages) {
          entries.push({ title, pageNumber, level });
        }
      }
      if (Array.isArray(node.items) && node.items.length > 0) {
        await walk(node.items, level + 1);
      }
    }
  };

  await walk(rawOutline, 0);
  return entries;
}

/** Título e autor dos metadados do PDF (vazios quando ausentes). */
export async function readPdfInfo(doc: PdfDocLike): Promise<{ title: string; author: string }> {
  let title = '';
  let author = '';
  try {
    const meta = await doc.getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    if (typeof info.Title === 'string') title = info.Title.trim();
    if (typeof info.Author === 'string') author = info.Author.trim();
  } catch {
    // Metadados ausentes ou corrompidos.
  }
  return { title, author };
}

/** Extrai itens de texto em coordenadas top-down usando a matriz do viewport (trata rotação e CropBox). */
export async function extractPageText(
  page: PdfPageLike,
  pageNumber: number,
): Promise<{ pageInput: PdfPageInput; charCount: number }> {
  const viewport = page.getViewport({ scale: 1 });
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const content = await page.getTextContent();
  const styles = content.styles;

  const items: PdfTextItem[] = [];
  let charCount = 0;

  for (const rawItem of content.items) {
    const raw = rawItem as { str?: string; transform: number[]; width: number; height: number; fontName: string };
    if (typeof raw.str !== 'string' || !raw.str) continue;
    const str = raw.str;

    const [, , tc, td, te, tf] = raw.transform;
    const x = va * te + vc * tf + ve;
    const y = vb * te + vd * tf + vf;
    const m2 = va * tc + vc * td;
    const m3 = vb * tc + vd * td;
    const h = Math.hypot(m2, m3) || Math.abs(raw.height) || 12;
    const w = Math.abs(raw.width);

    charCount += str.replace(/\s+/g, '').length;
    const font = resolveFontInfo(page, raw.fontName, styles);
    items.push({ str, x, y, w, h, fontName: font.name, ...(font.bold ? { bold: true } : {}), ...(font.italic ? { italic: true } : {}) });
  }

  return {
    pageInput: { pageNumber, width: viewport.width, height: viewport.height, items },
    charCount,
  };
}

/**
 * Fração da área da página coberta por imagens (0..1), a partir da lista de operadores do pdfjs.
 * Acompanha a matriz de transformação corrente (save/restore/transform e formulários XObject).
 * Imagens se sobrepondo são somadas e o resultado é limitado a 1.
 */
export function imageAreaFraction(
  fnArray: number[],
  argsArray: unknown[],
  ops: PdfOpsLike,
  pageWidth: number,
  pageHeight: number,
): number {
  const pageArea = pageWidth * pageHeight;
  if (!(pageArea > 0)) return 0;

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let area = 0;

  const multiply = (m: number[], c: number[]): number[] => [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5],
  ];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      const prev = stack.pop();
      if (prev) ctm = prev;
    } else if (fn === ops.transform) {
      if (Array.isArray(args) && args.length >= 6) ctm = multiply(args as number[], ctm);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = Array.isArray(args) ? (args[0] as unknown) : null;
      if (Array.isArray(m) && m.length >= 6) ctm = multiply(m as number[], ctm);
    } else if (fn === ops.paintFormXObjectEnd) {
      const prev = stack.pop();
      if (prev) ctm = prev;
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
      area += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    }
  }

  return Math.min(1, area / pageArea);
}

/** Mede a fração da página coberta por imagens (0 quando a lista de operadores não está disponível). */
export async function measurePageImageCoverage(page: PdfPageLike, ops: PdfOpsLike): Promise<number> {
  try {
    const viewport = page.getViewport({ scale: 1 });
    const list = await page.getOperatorList();
    return imageAreaFraction(list.fnArray, list.argsArray, ops, viewport.width, viewport.height);
  } catch {
    return 0;
  }
}

/** Converte erros do pdfjs em mensagens legíveis em português. Erros desconhecidos viram mensagem genérica. */
export function friendlyPdfError(err: unknown): Error {
  const name = err && typeof err === 'object' ? String((err as { name?: unknown }).name ?? '') : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'PasswordException') return new Error('PDF protegido por senha. Remova a senha e tente de novo.');
  if (name === 'InvalidPDFException') return new Error('Este arquivo PDF está corrompido ou não é um PDF válido.');
  if (name === 'MissingPDFException') return new Error('Arquivo PDF não encontrado.');
  if (err instanceof Error && /^(PDF|Este arquivo)/.test(message)) return err;
  return new Error(`Não foi possível ler o PDF${message ? ` (${message})` : ''}.`);
}
