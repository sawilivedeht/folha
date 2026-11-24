import { describe, expect, it } from 'vitest';
import { decodeText, parseTxt } from './txt';

describe('decodeText', () => {
  it('decodes UTF-8 without BOM', () => {
    const bytes = new TextEncoder().encode('Olá, coração!');
    expect(decodeText(bytes.buffer)).toBe('Olá, coração!');
  });

  it('decodes UTF-8 with BOM', () => {
    const payload = new TextEncoder().encode('Bom dia');
    const withBom = new Uint8Array(3 + payload.length);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(payload, 3);
    expect(decodeText(withBom.buffer)).toBe('Bom dia');
  });

  it('decodes UTF-16LE with BOM', () => {
    // BOM FF FE + "Oi" (0x4F 0x00 0x69 0x00)
    const buf = new Uint8Array([0xff, 0xfe, 0x4f, 0x00, 0x69, 0x00]).buffer;
    expect(decodeText(buf)).toBe('Oi');
  });

  it('decodes UTF-16BE with BOM', () => {
    // BOM FE FF + "Oi" (0x00 0x4F 0x00 0x69)
    const buf = new Uint8Array([0xfe, 0xff, 0x00, 0x4f, 0x00, 0x69]).buffer;
    expect(decodeText(buf)).toBe('Oi');
  });

  it('falls back to windows-1252 when UTF-8 is invalid', () => {
    // "coração" em windows-1252: 0xE7 = 'ç', 0xE3 = 'ã'
    const buf = new Uint8Array([0x63, 0x6f, 0x72, 0x61, 0xe7, 0xe3, 0x6f]).buffer;
    expect(decodeText(buf)).toBe('coração');
  });
});

describe('parseTxt', () => {
  it('extracts title from short first line and falls back to fileName for long first line', () => {
    const short = parseTxt('\uFEFFMemórias Póstumas\r\n\r\nPrimeiro parágrafo.', 'livro.txt');
    expect(short.title).toBe('Memórias Póstumas');

    const longFirst = 'Esta primeira linha é propositalmente muito longa e ultrapassa o limite de oitenta caracteres para título.';
    const fallback = parseTxt(`${longFirst}\n\nSegundo parágrafo.`, 'meu-livro.txt');
    expect(fallback.title).toBe('meu-livro');
  });

  it('reflows fixed-width wrapped lines (~60-80 cols) into paragraphs', () => {
    const wrapped = [
      'Título do Livro',
      '',
      'Esta é a primeira linha de um parágrafo longo que foi quebrado em',
      'largura fixa de aproximadamente setenta colunas para caber em telas',
      'antigas de terminal sem quebra automática de linha no leitor.',
      '',
      'Já este segundo parágrafo também segue exatamente o mesmo padrão de',
      'formatação com linhas de sessenta a oitenta caracteres separados por',
      'uma linha em branco entre os parágrafos do texto original.',
    ].join('\n');

    const book = parseTxt(wrapped, 'wrapped.txt');
    expect(book.chapters).toHaveLength(1);
    const paragraphs = book.chapters[0].blocks.filter((b) => b.t === 'p');
    expect(paragraphs).toHaveLength(3); // título + 2 parágrafos refluídos
    expect(paragraphs[1].text).toContain('largura fixa de aproximadamente setenta colunas para caber em telas antigas');
    expect(paragraphs[2].text).toContain('formatação com linhas de sessenta a oitenta caracteres separados por uma linha');
  });

  it('detects chapters by headings and uppercase lines', () => {
    const text = [
      'Romance Exemplo',
      '',
      'Capítulo 1',
      'Texto do primeiro capítulo.',
      '',
      'CAPÍTULO II',
      'Texto do segundo capítulo.',
      '',
      'Chapter 3',
      'Text of chapter three.',
      '',
      'PARTE FINAL',
      '',
      'Desfecho da história.',
    ].join('\n');

    const book = parseTxt(text, 'romance.txt');
    expect(book.title).toBe('Romance Exemplo');
    // A folha de rosto curta ("Romance Exemplo") entra no 1º capítulo em vez de virar capítulo próprio.
    expect(book.chapters.map((c) => c.title)).toEqual([
      'Capítulo 1',
      'CAPÍTULO II',
      'Chapter 3',
      'PARTE FINAL',
    ]);
    expect(book.chapters[0].blocks[0]).toEqual({ t: 'p', text: 'Romance Exemplo' });
    expect(book.chapters[0].blocks[1]).toEqual({ t: 'h', level: 1, text: 'Capítulo 1' });
    expect(book.chapters[0].blocks[2]).toEqual({ t: 'p', text: 'Texto do primeiro capítulo.' });
  });

  it('splits into ~40k char "Parte N" chapters when no headings exist', () => {
    const para = 'A'.repeat(25_000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const book = parseTxt(text, 'grande.txt');
    expect(book.chapters.map((c) => c.title)).toEqual(['Parte 1', 'Parte 2', 'Parte 3']);
  });
});
