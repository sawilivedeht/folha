import { describe, expect, it } from 'vitest';
import { decodeText, parseTxt } from './txt';

const ab = (bytes: number[] | Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

function utf16(text: string, le: boolean, bom = true): Uint8Array {
  const out: number[] = bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const units = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
    for (const u of units) out.push(...(le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
  }
  return new Uint8Array(out);
}

describe('decodeText: codificações reais', () => {
  const sample = 'Ação, coração, pé, à vista — “aspas” e € 10';

  it('UTF-8 com BOM remove o BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(sample)]);
    expect(decodeText(ab(bytes))).toBe(sample);
  });

  it('UTF-16LE e UTF-16BE com BOM, inclusive pares substitutos', () => {
    const withEmoji = `${sample} 😀`;
    expect(decodeText(ab(utf16(withEmoji, true)))).toBe(withEmoji);
    expect(decodeText(ab(utf16(withEmoji, false)))).toBe(withEmoji);
  });

  it('windows-1252 com bytes reais (0xE7, 0xE3, 0xE9, 0x96, 0x93/0x94)', () => {
    // "ação — “ok” é": 0xE7=ç 0xE3=ã 0x96=– (travessão en) 0x93/0x94 = aspas curvas
    const bytes = new Uint8Array([0x61, 0xe7, 0xe3, 0x6f, 0x20, 0x96, 0x20, 0x93, 0x6f, 0x6b, 0x94, 0x20, 0xe9]);
    expect(decodeText(ab(bytes))).toBe('ação – “ok” é');
  });

  it('arquivo vazio vira string vazia', () => {
    expect(decodeText(ab([]))).toBe('');
  });

  it('só o BOM vira string vazia', () => {
    expect(decodeText(ab([0xef, 0xbb, 0xbf]))).toBe('');
    expect(decodeText(ab([0xff, 0xfe]))).toBe('');
  });

  it('UTF-8 válido sem BOM é preservado (não confunde com windows-1252)', () => {
    expect(decodeText(new TextEncoder().encode('é ç ã').buffer as ArrayBuffer)).toBe('é ç ã');
  });
});

describe('parseTxt: entradas reais', () => {
  it('arquivo vazio produz livro sem capítulos', () => {
    const book = parseTxt('', 'vazio.txt');
    expect(book.chapters).toEqual([]);
    expect(book.title).toBe('vazio');
  });

  it('só espaços e quebras de linha produz livro sem capítulos', () => {
    expect(parseTxt('\n\n   \r\n\t\n', 'x.txt').chapters).toEqual([]);
  });

  it('uma linha só gigante (sem quebras) vira um único capítulo e usa o nome do arquivo como título', () => {
    const giant = `${'palavra '.repeat(30_000)}fim`;
    const book = parseTxt(giant, 'gigante.txt');
    expect(book.title).toBe('gigante');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].blocks).toHaveLength(1);
    expect(book.chapters[0].blocks[0].t).toBe('p');
  });

  it('capítulos em algarismos romanos isolados', () => {
    const text = ['Um Romance', '', 'I', '', 'Era uma vez um começo.', '', 'II', '', 'E houve um meio.', '', 'III.', '', 'Por fim, o fim.'].join('\n');
    const book = parseTxt(text, 'r.txt');
    expect(book.chapters.map((c) => c.title)).toEqual(['I', 'II', 'III.']);
    expect(book.chapters[0].blocks[0]).toEqual({ t: 'p', text: 'Um Romance' });
    expect(book.chapters[1].blocks[1]).toEqual({ t: 'p', text: 'E houve um meio.' });
  });

  it('romano no meio de frase não é título', () => {
    const book = parseTxt('Texto\nI\nsegue a frase', 'a.txt');
    expect(book.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'h')).toEqual([]);
  });

  it('palavras-chave de seção: Prólogo, Epílogo, Parte 2, Introdução', () => {
    const text = ['Título', '', 'Prólogo', '', 'antes', '', 'Parte 2', 'meio', '', 'EPÍLOGO', '', 'depois'].join('\n');
    const titles = parseTxt(text, 'k.txt').chapters.map((c) => c.title);
    expect(titles).toEqual(['Prólogo', 'Parte 2', 'EPÍLOGO']);
  });

  it('refluxo de largura fixa junta linhas em parágrafos e mantém capítulos', () => {
    const wrap = (s: string, width = 66): string[] => {
      const words = s.split(' ');
      const out: string[] = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > width) {
          out.push(cur);
          cur = w;
        } else cur = (cur + ' ' + w).trim();
      }
      if (cur) out.push(cur);
      return out;
    };
    const p1 = 'No princípio, o texto era quebrado em linhas curtas por editores antigos que não sabiam de telas pequenas nem de fontes variáveis. '.repeat(2).trim();
    const p2 = 'Mais adiante, o segundo parágrafo seguia o mesmo costume de largura fixa, terminando cada linha antes da margem direita do terminal. '.repeat(2).trim();
    const text = ['Antologia', '', 'CAPÍTULO 1', '', ...wrap(p1), '', ...wrap(p2), '', 'CAPÍTULO 2', '', ...wrap(p1)].join('\n');
    const book = parseTxt(text, 'wrap.txt');
    expect(book.chapters.map((c) => c.title)).toEqual(['CAPÍTULO 1', 'CAPÍTULO 2']);
    // O 1º parágrafo é a folha de rosto ("Antologia"), que entra no 1º capítulo.
    const paras = book.chapters[0].blocks.filter((b) => b.t === 'p').slice(1);
    expect(paras).toHaveLength(2);
    expect(paras[0].t === 'p' && paras[0].text).toBe(p1);
    expect(paras[1].t === 'p' && paras[1].text).toBe(p2);
  });

  it('sem refluxo (linhas curtas de poema) cada linha vira um bloco', () => {
    const poem = ['Poema', '', 'Verso um', 'Verso dois', 'Verso três'].join('\n');
    const blocks = parseTxt(poem, 'p.txt').chapters.flatMap((c) => c.blocks);
    expect(blocks.map((b) => ('text' in b ? b.text : ''))).toEqual(['Poema', 'Verso um', 'Verso dois', 'Verso três']);
  });

  it('CRLF e CR antigo são normalizados', () => {
    const book = parseTxt('Titulo\r\n\r\nUm\rDois\r\n', 'crlf.txt');
    const texts = book.chapters.flatMap((c) => c.blocks).map((b) => ('text' in b ? b.text : ''));
    expect(texts).toEqual(['Titulo', 'Um', 'Dois']);
  });

  it('texto grande sem títulos é dividido em partes de ~40 mil caracteres', () => {
    const para = 'x'.repeat(10_000);
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const book = parseTxt(text, 'g.txt');
    expect(book.chapters.length).toBeGreaterThanOrEqual(2);
    expect(book.chapters.every((c) => c.title.startsWith('Parte '))).toBe(true);
  });

  it('título ".txt" sem nome cai em "Sem título"', () => {
    expect(parseTxt('\n', '.txt').title).toBe('Sem título');
  });

  it('decodifica e analisa um arquivo windows-1252 de ponta a ponta', () => {
    // "Coração" em windows-1252
    const bytes = new Uint8Array([0x43, 0x6f, 0x72, 0x61, 0xe7, 0xe3, 0x6f, 0x0a, 0x0a, 0x4c, 0x69, 0x6e, 0x68, 0x61, 0xe9]);
    const book = parseTxt(decodeText(ab(bytes)), 'l.txt');
    expect(book.title).toBe('Coração');
    expect(book.chapters[0].blocks[1]).toEqual({ t: 'p', text: 'Linhaé' });
  });
});
