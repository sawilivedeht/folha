#!/usr/bin/env node
// CLI Node para validar a conversão de um PDF real para livro refluível.
//
// Como executar:
//   node --experimental-strip-types scripts/convert-pdf.mjs <caminho/arquivo.pdf>
// (No Node 22.18+ / 24+, também funciona sem a flag: `node scripts/convert-pdf.mjs <arquivo.pdf>`)

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfChapters } from '../src/import/pdf-layout.ts';

const SCANNED_CHARS_THRESHOLD = 40;
const SCANNED_RATIO_THRESHOLD = 0.7;
const PREVIEW_CHARS = 3000;

function titleFromFileName(fileName) {
  const base = basename(fileName).replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Sem título';
}

function resolveFontName(page, fontName, styles) {
  try {
    if (page.commonObjs && typeof page.commonObjs.has === 'function' && page.commonObjs.has(fontName)) {
      const obj = page.commonObjs.get(fontName);
      if (obj && typeof obj.name === 'string' && obj.name.length > 0) return obj.name;
    }
  } catch {
    // Ignora se a fonte não estiver disponível em commonObjs.
  }
  const family = styles?.[fontName]?.fontFamily;
  return family ? `${fontName} ${family}` : fontName;
}

async function resolveDestPageNumber(doc, dest) {
  if (!dest) return null;
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    if (typeof ref === 'number') return ref + 1;
    if (ref && typeof ref === 'object') {
      const idx = await doc.getPageIndex(ref);
      return idx + 1;
    }
  } catch {
    return null;
  }
  return null;
}

async function extractOutline(doc) {
  let rawOutline = null;
  try {
    rawOutline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!rawOutline || rawOutline.length === 0) return [];

  const entries = [];
  const walk = async (nodes, level) => {
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

function formatBlock(block) {
  switch (block.t) {
    case 'h':
      return `${'#'.repeat(block.level)} ${block.text}`;
    case 'li':
      return `${block.ordered ? '1.' : '•'} ${block.text}`;
    case 'quote':
      return `> ${block.text}`;
    case 'pre':
      return block.text;
    case 'img':
      return `[Imagem: ${block.src}${block.alt ? ` (${block.alt})` : ''}]`;
    case 'hr':
      return '---';
    case 'p':
    default:
      return block.text;
  }
}

function blockChars(block) {
  return 'text' in block ? block.text.length : 0;
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Uso: node --experimental-strip-types scripts/convert-pdf.mjs <arquivo.pdf>');
    process.exit(1);
  }

  const fileBytes = await readFile(pdfPath);
  const loadingTask = getDocument({
    data: new Uint8Array(fileBytes),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  try {
    const numPages = doc.numPages;

    let title = '';
    let author = '';
    try {
      const meta = await doc.getMetadata();
      const info = meta?.info ?? {};
      if (typeof info.Title === 'string') title = info.Title.trim();
      if (typeof info.Author === 'string') author = info.Author.trim();
    } catch {
      // Sem metadados.
    }
    if (!title) title = titleFromFileName(pdfPath);

    const outline = await extractOutline(doc);
    const pages = [];
    let lowTextPages = 0;

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const [va, vb, vc, vd, ve, vf] = viewport.transform;
        const content = await page.getTextContent();
        const items = [];
        let charCount = 0;

        for (const raw of content.items) {
          if (!('str' in raw) || !raw.str) continue;
          const [, , tc, td, te, tf] = raw.transform;
          const x = va * te + vc * tf + ve;
          const y = vb * te + vd * tf + vf;
          const m2 = va * tc + vc * td;
          const m3 = vb * tc + vd * td;
          const h = Math.hypot(m2, m3) || Math.abs(raw.height) || 12;
          const w = Math.abs(raw.width);

          charCount += raw.str.replace(/\s+/g, '').length;
          items.push({
            str: raw.str,
            x,
            y,
            w,
            h,
            fontName: resolveFontName(page, raw.fontName, content.styles),
          });
        }

        if (charCount < SCANNED_CHARS_THRESHOLD) lowTextPages++;
        pages.push({ pageNumber: i, width: viewport.width, height: viewport.height, items });
      } finally {
        page.cleanup();
      }
    }

    const isScanned = numPages > 0 && lowTextPages / numPages > SCANNED_RATIO_THRESHOLD;
    const chapters = extractPdfChapters(pages, { outline, yOrigin: 'top-down' });

    const chapterTotals = chapters.map((ch) => ch.blocks.reduce((sum, b) => sum + blockChars(b), 0));
    const totalChars = chapterTotals.reduce((a, b) => a + b, 0);

    console.log(`Arquivo: ${pdfPath}`);
    console.log(`Título: ${title}`);
    if (author) console.log(`Autor: ${author}`);
    console.log(`Páginas: ${numPages} | Entradas no sumário: ${outline.length}`);
    if (isScanned) {
      console.log(`AVISO: PDF escaneado detectado (${lowTextPages}/${numPages} páginas com < ${SCANNED_CHARS_THRESHOLD} caracteres).`);
    }
    console.log(`Capítulos: ${chapters.length}`);
    console.log(`Total de caracteres: ${totalChars}`);
    console.log('\n--- Lista de capítulos ---');
    chapters.forEach((ch, idx) => {
      console.log(`${String(idx + 1).padStart(3, ' ')}. ${ch.title} (${chapterTotals[idx]} chars, ${ch.blocks.length} blocos)`);
    });

    console.log(`\n--- Primeiros ~${PREVIEW_CHARS} caracteres convertidos ---`);
    let printed = 0;
    outer: for (const ch of chapters) {
      const header = `\n=== ${ch.title} ===\n`;
      process.stdout.write(header);
      printed += header.length;
      for (const blk of ch.blocks) {
        const line = `${formatBlock(blk)}\n\n`;
        if (printed + line.length > PREVIEW_CHARS) {
          const remaining = Math.max(0, PREVIEW_CHARS - printed);
          if (remaining > 0) process.stdout.write(line.slice(0, remaining) + '...\n');
          break outer;
        }
        process.stdout.write(line);
        printed += line.length;
      }
    }
  } finally {
    await loadingTask.destroy();
  }
}

main().catch((err) => {
  console.error('Erro ao converter PDF:', err);
  process.exit(1);
});
