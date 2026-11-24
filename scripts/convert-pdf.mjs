#!/usr/bin/env node
// CLI Node para validar a conversão de um PDF real para livro refluível.
//
// Como executar:
//   node --experimental-strip-types scripts/convert-pdf.mjs <caminho/arquivo.pdf>
// (No Node 22.18+ / 24+, também funciona sem a flag: `node scripts/convert-pdf.mjs <arquivo.pdf>`)

import { readFile } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfChapters, extractPdfPageBlocks } from '../src/import/pdf-layout.ts';
import {
  extractOutline,
  extractPageText,
  friendlyPdfError,
  measurePageImageCoverage,
  readPdfInfo,
  titleFromFileName,
} from '../src/import/pdf-extract.ts';
import { buildSlideChapters, classifyPdf, SCANNED_CHARS_THRESHOLD } from '../src/import/pdf-slides.ts';

const PREVIEW_CHARS = 3000;

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
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    throw friendlyPdfError(err);
  }

  try {
    const numPages = doc.numPages;
    if (numPages < 1) throw new Error('O PDF não tem páginas.');

    const info = await readPdfInfo(doc);
    const title = info.title || titleFromFileName(pdfPath);
    const author = info.author;

    const outline = await extractOutline(doc);
    const pages = [];
    const stats = [];
    let imagePages = 0;
    let lowTextPages = 0;

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      try {
        // A lista de operadores carrega as fontes (nome/negrito/itálico); precisa vir antes do texto.
        const coverage = await measurePageImageCoverage(page, OPS);
        const { pageInput, charCount } = await extractPageText(page, i);
        if (charCount < SCANNED_CHARS_THRESHOLD) lowTextPages++;
        if (charCount >= 10 && coverage > 0.4) imagePages++;
        stats.push({ width: pageInput.width, height: pageInput.height, chars: charCount });
        pages.push(pageInput);
      } finally {
        page.cleanup();
      }
    }

    const kind = classifyPdf(stats);
    const isScanned = kind === 'scanned';
    const slideDeck = kind === 'slides';
    let chapters;
    if (slideDeck) {
      // No navegador cada slide também ganha uma imagem renderizada; aqui só simulamos a chave.
      const slides = extractPdfPageBlocks(pages, { yOrigin: 'top-down' }).map((p) => ({
        pageNumber: p.pageNumber,
        blocks: p.blocks,
        image: { src: `p${String(p.pageNumber).padStart(4, '0')}`, w: 1280, h: 720 },
      }));
      chapters = buildSlideChapters(slides);
    } else {
      chapters = extractPdfChapters(pages, { outline, yOrigin: 'top-down' });
    }

    const chapterTotals = chapters.map((ch) => ch.blocks.reduce((sum, b) => sum + blockChars(b), 0));
    const totalChars = chapterTotals.reduce((a, b) => a + b, 0);

    console.log(`Arquivo: ${pdfPath}`);
    console.log(`Título: ${title}`);
    if (author) console.log(`Autor: ${author}`);
    console.log(`Páginas: ${numPages} | Entradas no sumário: ${outline.length}`);
    if (isScanned) {
      console.log(`AVISO: PDF escaneado detectado (${lowTextPages}/${numPages} páginas com < ${SCANNED_CHARS_THRESHOLD} caracteres).`);
    }
    if (slideDeck) console.log('Modo: apresentação de slides (imagem + texto por slide)');
    if (imagePages > 0) console.log(`Páginas de texto com figura grande: ${imagePages}`);
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
