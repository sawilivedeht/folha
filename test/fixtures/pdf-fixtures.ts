// Geradores de PDFs de teste (pdf-lib). Tudo em memória: nenhum arquivo binário é versionado.
// Helvetica/Times usam WinAnsi, que cobre os acentos do português.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib';

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  times: PDFFont;
}

async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    times: await doc.embedFont(StandardFonts.TimesRoman),
  };
  return { doc, fonts };
}

/** Quebra um parágrafo em linhas que cabem em `maxWidth` (sem hifenização). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Cria um PNG RGB sólido minúsculo (para páginas "escaneadas" ou com figura). */
export function solidPng(width: number, height: number, rgbColor: [number, number, number]): Uint8Array {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(rgbColor, y * (width * 3 + 1) + 1 + x * 3);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface BookPdfOptions {
  /** Parágrafos do corpo; cada um já pode conter hífen ao fim da linha como "informa-" + "ção" (use `­`-free texto). */
  paragraphs: string[];
  /** Capítulos: título (fonte maior) inserido antes do parágrafo de índice indicado. */
  headings?: Array<{ before: number; text: string; size?: number }>;
  header?: string;
  footerPageNumbers?: boolean;
  pageWidth?: number;
  pageHeight?: number;
  /** Largura máxima do texto; força quebras e hifenização no fim da linha. */
  textWidth?: number;
  fontSize?: number;
  /** Se verdadeiro, hifeniza a última palavra que não coube (corta a palavra e põe "-" no fim da linha). */
  hyphenate?: boolean;
}

/** Quebra com hifenização: se a próxima palavra não cabe e é longa, divide-a com hífen. */
export function wrapWithHyphens(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      cur = next;
      continue;
    }
    // Tenta cortar a palavra: maior prefixo (>=3 letras, deixando >=3 letras) que cabe com hífen.
    let placed = false;
    if (w.length >= 8 && cur) {
      for (let cut = w.length - 3; cut >= 3; cut--) {
        const candidate = `${cur} ${w.slice(0, cut)}-`;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
          lines.push(candidate);
          cur = w.slice(cut);
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Livro com parágrafos por várias páginas, cabeçalho repetido, rodapé com número e títulos maiores. */
export async function buildBookPdf(opts: BookPdfOptions): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const W = opts.pageWidth ?? 420;
  const H = opts.pageHeight ?? 595;
  const size = opts.fontSize ?? 11;
  const lead = size * 1.45;
  const textWidth = opts.textWidth ?? W - 110;
  const left = 55;
  const top = H - 70;
  const bottom = 70;

  let page: PDFPage = doc.addPage([W, H]);
  let pageNo = 1;
  let y = top;

  const decorate = (p: PDFPage, n: number) => {
    if (opts.header) p.drawText(opts.header, { x: left, y: H - 35, size: 9, font: fonts.regular });
    if (opts.footerPageNumbers) p.drawText(String(n), { x: W / 2 - 4, y: 30, size: 9, font: fonts.regular });
  };
  decorate(page, pageNo);

  const newPage = () => {
    page = doc.addPage([W, H]);
    pageNo++;
    y = top;
    decorate(page, pageNo);
  };
  const drawLine = (text: string, font: PDFFont, s: number, step: number) => {
    if (y - step < bottom) newPage();
    page.drawText(text, { x: left, y, size: s, font });
    y -= step;
  };

  const headingAt = new Map<number, Array<{ text: string; size?: number }>>();
  for (const h of opts.headings ?? []) {
    const list = headingAt.get(h.before) ?? [];
    list.push(h);
    headingAt.set(h.before, list);
  }

  for (let i = 0; i < opts.paragraphs.length; i++) {
    for (const h of headingAt.get(i) ?? []) {
      y -= lead * 0.8;
      if (y - 40 < bottom) newPage();
      drawLine(h.text, fonts.bold, h.size ?? 20, (h.size ?? 20) * 1.6);
    }
    const lines = opts.hyphenate
      ? wrapWithHyphens(opts.paragraphs[i], fonts.regular, size, textWidth)
      : wrapText(opts.paragraphs[i], fonts.regular, size, textWidth);
    for (const ln of lines) drawLine(ln, fonts.regular, size, lead);
    y -= lead * 0.6;
  }
  return doc.save();
}

/** Página de duas colunas: a coluna da esquerda deve ser lida inteira antes da da direita. */
export async function buildTwoColumnPdf(left: string[], right: string[]): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const page = doc.addPage([595, 842]);
  const size = 11;
  const draw = (lines: string[], x: number) => {
    let y = 760;
    for (const ln of lines) {
      page.drawText(ln, { x, y, size, font: fonts.regular });
      y -= size * 1.5;
    }
  };
  draw(left, 50);
  draw(right, 320);
  return doc.save();
}

/** Lista com marcadores (•) e negrito/itálico no meio do texto. */
export async function buildListAndStylesPdf(): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const page = doc.addPage([420, 595]);
  let y = 520;
  const line = (text: string, x = 55, font = fonts.regular, size = 11) => {
    page.drawText(text, { x, y, size, font });
    y -= 17;
  };
  line('Os principais pontos são os seguintes:');
  y -= 6;
  line('• primeiro item da lista de verificação', 70);
  line('• segundo item da lista de verificação', 70);
  line('• terceiro item da lista de verificação', 70);
  y -= 14;
  // Linha mista: regular + negrito + itálico.
  const parts: Array<[string, PDFFont]> = [
    ['Um trecho com ', fonts.regular],
    ['palavra em negrito', fonts.bold],
    [' e ', fonts.regular],
    ['em itálico', fonts.italic],
    [' juntas.', fonts.regular],
  ];
  let x = 55;
  for (const [t, f] of parts) {
    page.drawText(t, { x, y, size: 11, font: f });
    x += f.widthOfTextAtSize(t, 11);
  }
  return doc.save();
}

/** PDF "escaneado": só imagens, sem camada de texto. */
export async function buildScannedPdf(pages: number): Promise<Uint8Array> {
  const { doc } = await newDoc();
  const png = await doc.embedPng(solidPng(8, 8, [40, 40, 40]));
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([420, 595]);
    page.drawImage(png, { x: 0, y: 0, width: 420, height: 595 });
  }
  return doc.save();
}

export interface SlideSpec {
  title: string;
  lines?: string[];
  /** Desenha uma figura grande cobrindo esta fração da largura/altura (0..1). */
  figure?: number;
}

/** Apresentação em paisagem (16:9): título grande e poucas linhas por slide. */
export async function buildSlidesPdf(slides: SlideSpec[], opts: { footer?: string } = {}): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const png = await doc.embedPng(solidPng(8, 8, [200, 60, 60]));
  for (const s of slides) {
    const page = doc.addPage([720, 405]);
    page.drawText(s.title, { x: 40, y: 340, size: 30, font: fonts.bold });
    let y = 290;
    for (const ln of s.lines ?? []) {
      page.drawText(ln, { x: 60, y, size: 18, font: fonts.regular, color: rgb(0.1, 0.1, 0.1) });
      y -= 28;
    }
    if (s.figure) {
      page.drawImage(png, { x: 720 * (1 - s.figure) / 2, y: 405 * (1 - s.figure) / 2, width: 720 * s.figure, height: 405 * s.figure });
    }
    if (opts.footer) page.drawText(opts.footer, { x: 40, y: 15, size: 9, font: fonts.regular });
  }
  return doc.save();
}

/** PDF de texto (retrato) com uma figura grande no meio de uma página cheia de texto. */
export async function buildTextWithFigurePdf(): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const png = await doc.embedPng(solidPng(8, 8, [60, 90, 200]));
  const long =
    'Este parágrafo tem bastante texto para que a página não seja considerada apresentação nem escaneada, ' +
    'descrevendo a figura que aparece logo abaixo e explicando o contexto em que ela foi produzida.';
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([420, 595]);
    let y = 540;
    for (const ln of wrapText(long.repeat(6), fonts.regular, 11, 310)) {
      if (y < 60) break;
      page.drawText(ln, { x: 55, y, size: 11, font: fonts.regular });
      y -= 16;
    }
    if (p === 1) page.drawImage(png, { x: 20, y: 20, width: 380, height: 555, opacity: 0.4 });
  }
  return doc.save();
}

/** PDF escaneado com camada de texto OCR: todas as páginas têm imagem inteira e texto abundante. */
export async function buildOcrPdf(pages: number): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const png = await doc.embedPng(solidPng(8, 8, [230, 225, 215]));
  const body =
    'Este livro digitalizado recebeu reconhecimento óptico de caracteres em todas as páginas, ' +
    'mantendo a imagem escaneada de página inteira atrás da camada de texto pesquisável.';
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([420, 595]);
    page.drawImage(png, { x: 0, y: 0, width: 420, height: 595 });
    let y = 540;
    for (const ln of wrapText(body.repeat(6), fonts.regular, 11, 310)) {
      if (y < 60) break;
      page.drawText(ln, { x: 55, y, size: 11, font: fonts.regular });
      y -= 16;
    }
  }
  return doc.save();
}

/** PDF com texto horizontal normal e selos rotacionados (90° na margem esquerda e 180° invertido). */
export async function buildRotatedStampPdf(): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc();
  const page = doc.addPage([595, 842]);
  const lines = [
    'Primeira linha do artigo científico com texto horizontal normal e legível.',
    'Segunda linha do artigo que não pode ser misturada ao selo vertical da margem.',
    'Terceira linha completa o parágrafo para garantir extração limpa no leitor.',
  ];
  let y = 600;
  for (const ln of lines) {
    page.drawText(ln, { x: 80, y, size: 12, font: fonts.regular });
    y -= 20;
  }
  page.drawText('arXiv:2401.12345v1 [cs.CL] 15 Jan 2024', {
    x: 25,
    y: 450,
    size: 11,
    font: fonts.regular,
    rotate: degrees(90),
  });
  page.drawText('TEXTO INVERTIDO 180', {
    x: 400,
    y: 580,
    size: 12,
    font: fonts.regular,
    rotate: degrees(180),
  });
  return doc.save();
}

/** PDF válido com árvore de páginas vazia (0 páginas), escrito à mão: o pdf-lib sempre inclui ao menos uma. */
export function buildZeroPagesPdf(): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export async function buildEmptyPagesPdf(pages: number): Promise<Uint8Array> {
  const { doc } = await newDoc();
  for (let i = 0; i < pages; i++) doc.addPage([420, 595]);
  return doc.save();
}

/**
 * PDF mínimo protegido por senha (RC4 de 40 bits, handler padrão revisão 2), escrito à mão.
 * O pdf.js só precisa do dicionário /Encrypt para pedir a senha; o conteúdo nem é descriptografado.
 */
export function buildPasswordPdf(userPassword = 'segredo'): Uint8Array {
  const PAD = Buffer.from(
    '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A',
    'hex',
  );
  const rc4 = (key: Buffer, data: Buffer): Buffer => {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255;
      [s[i], s[j]] = [s[j], s[i]];
    }
    const out = Buffer.alloc(data.length);
    let a = 0;
    let b = 0;
    for (let k = 0; k < data.length; k++) {
      a = (a + 1) & 255;
      b = (b + s[a]) & 255;
      [s[a], s[b]] = [s[b], s[a]];
      out[k] = data[k] ^ s[(s[a] + s[b]) & 255];
    }
    return out;
  };
  const md5 = (b: Buffer) => createHash('md5').update(b).digest();
  const padPw = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

  const ownerEntry = rc4(md5(padPw('dono')).subarray(0, 5), padPw(userPassword));
  const P = -4;
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const id = Buffer.from('0123456789abcdef');
  const key = md5(Buffer.concat([padPw(userPassword), ownerEntry, pBytes, id])).subarray(0, 5);
  const userEntry = rc4(key, PAD);

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P ${P} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
