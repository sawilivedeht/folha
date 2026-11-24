import { describe, expect, it } from 'vitest';
import type { ParsedBook } from '../types';
import { buildMeta, detectFormat } from './index';

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

describe('detectFormat', () => {
  it('detecta PDF pela assinatura %PDF mesmo sem extensão .pdf', () => {
    const bytes = asciiBytes('%PDF-1.7\n...');
    expect(detectFormat(bytes, 'documento.bin')).toBe('pdf');
  });

  it('detecta EPUB pela assinatura PK + mimetype application/epub+zip', () => {
    const header = new Uint8Array(80);
    header.set([0x50, 0x4b, 0x03, 0x04], 0);
    header.set(asciiBytes('mimetypeapplication/epub+zip'), 30);
    expect(detectFormat(header, 'livro.zip')).toBe('epub');
  });

  it('usa extensão como fallback para PDF, EPUB, TXT e MD', () => {
    const empty = new Uint8Array(0);
    expect(detectFormat(empty, 'manual.PDF')).toBe('pdf');
    expect(detectFormat(empty, 'romance.epub')).toBe('epub');
    expect(detectFormat(empty, 'notas.txt')).toBe('txt');
    expect(detectFormat(empty, 'artigo.MD')).toBe('txt');
  });

  it('retorna null para formato não suportado', () => {
    const bytes = asciiBytes('RIFF....WEBP');
    expect(detectFormat(bytes, 'planilha.xlsx')).toBeNull();
    expect(detectFormat(bytes, 'sem-extensao')).toBeNull();
  });
});

describe('buildMeta', () => {
  it('calcula chapterChars, totalChars, chapterTitles e campos iniciais', () => {
    const parsed: ParsedBook = {
      title: '  Dom Casmurro  ',
      author: ' Machado de Assis ',
      lang: 'pt-BR',
      fixedLayout: false,
      cover: new Blob(['capa'], { type: 'image/png' }),
      images: new Map(),
      chapters: [
        {
          title: 'Capítulo I',
          blocks: [
            { t: 'h', level: 1, text: 'Do título' }, // 9
            { t: 'p', text: 'Uma noite destas.' }, // 17
            { t: 'hr' },
          ],
        },
        {
          title: 'Capítulo II',
          blocks: [
            { t: 'quote', text: 'Citação' }, // 7
            { t: 'li', text: 'Item' }, // 4
            { t: 'pre', text: '123' }, // 3
            { t: 'img', src: 'fig1.png', alt: 'Ignorado na contagem' },
          ],
        },
      ],
    };

    const meta = buildMeta(
      parsed,
      { fileName: 'dom-casmurro.epub', format: 'epub' },
      'book-123',
      1_700_000_000_000,
    );

    expect(meta).toEqual({
      id: 'book-123',
      title: 'Dom Casmurro',
      author: 'Machado de Assis',
      lang: 'pt-BR',
      format: 'epub',
      fileName: 'dom-casmurro.epub',
      addedAt: 1_700_000_000_000,
      hasCover: true,
      fixedLayout: false,
      chapterChars: [26, 14],
      totalChars: 40,
      chapterTitles: ['Capítulo I', 'Capítulo II'],
      position: { chapter: 0, block: 0 },
      percent: 0,
      bookmarks: [],
    });
  });

  it('usa nome do arquivo sem extensão quando título está vazio e hasCover false sem capa', () => {
    const parsed: ParsedBook = {
      title: '   ',
      images: new Map(),
      chapters: [
        {
          title: 'Único',
          blocks: [{ t: 'p', text: 'Olá' }],
        },
      ],
    };

    const meta = buildMeta(parsed, { fileName: 'rascunho.txt', format: 'txt' }, 'id-2', 42);

    expect(meta.title).toBe('rascunho');
    expect(meta.author).toBeUndefined();
    expect(meta.hasCover).toBe(false);
    expect(meta.fixedLayout).toBeUndefined();
    expect(meta.chapterChars).toEqual([3]);
    expect(meta.totalChars).toBe(3);
  });
});
