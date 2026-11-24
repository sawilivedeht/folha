// Regressões achadas ao converter arquivos reais (scripts/corpus.mjs), reproduzidas de forma sintética.
import { describe, expect, it } from 'vitest';
import { cleanPdfTitle, readPdfInfo, type PdfDocLike } from './pdf-extract';
import { extractPdfChapters, type PdfPageInput, type PdfTextItem } from './pdf-layout';

const item = (str: string, x: number, y: number, h = 12, w = Math.max(4, str.length * h * 0.52)): PdfTextItem => ({
  str,
  x,
  y,
  w,
  h,
  fontName: 'Times-Roman',
});
const page = (pageNumber: number, items: PdfTextItem[]): PdfPageInput => ({ pageNumber, width: 600, height: 800, items });

describe('título do PDF vindo dos metadados', () => {
  it('descarta nomes de arquivo e textos padrão, mantém títulos de verdade', () => {
    expect(cleanPdfTitle('RELATORIO.pdf - RELATORIO.pdf')).toBe('');
    expect(cleanPdfTitle('relatorio final.docx')).toBe('');
    expect(cleanPdfTitle('Microsoft Word - Monografia.doc')).toBe('');
    expect(cleanPdfTitle('Untitled')).toBe('');
    expect(cleanPdfTitle('Documento1')).toBe('');
    expect(cleanPdfTitle('   \u0000�  ')).toBe('');
    expect(cleanPdfTitle('---')).toBe('');
    expect(cleanPdfTitle('Microsoft Word - Introdução à Física')).toBe('Introdução à Física');
    expect(cleanPdfTitle('  Dom Casmurro  ')).toBe('Dom Casmurro');
    expect(cleanPdfTitle('Teoria.pdf e prática')).toBe('Teoria.pdf e prática');
  });

  it('readPdfInfo devolve título vazio quando o metadado é só o nome do arquivo', async () => {
    const doc = { getMetadata: async () => ({ info: { Title: 'RELATORIO.pdf - RELATORIO.pdf', Author: ' Fulana ' } }) } as unknown as PdfDocLike;
    expect(await readPdfInfo(doc)).toEqual({ title: '', author: 'Fulana' });
  });
});

describe('capítulos minúsculos de pranchas e figuras', () => {
  const corpo = (p: number) =>
    page(p, [
      item('Um capítulo de verdade tem bastante texto corrido, com várias frases completas e pontuação.', 60, 700, 12, 480),
      item('Segunda linha do parágrafo, que continua explicando o assunto com calma e sem pressa nenhuma.', 60, 684, 12, 480),
      item('Terceira linha fecha o parágrafo com mais algumas palavras para passar de trezentos caracteres.', 60, 668, 12, 480),
      item('Quarta linha para garantir o tamanho mínimo esperado de um capítulo normal de livro.', 60, 652, 12, 480),
    ]);

  // Pranchas técnicas: letras grandes das molduras ("F", "E", "4 3") parecem títulos.
  const prancha = (p: number) => page(p, ['F', 'E', 'D', 'C', 'B', 'A'].map((l, i) => item(l, 30, 700 - i * 90, 30, 16)));

  it('uma sequência de pranchas não vira dezenas de capítulos', () => {
    const pages = [corpo(1), corpo(2), ...Array.from({ length: 10 }, (_, i) => prancha(3 + i))];
    const chapters = extractPdfChapters(pages);
    expect(chapters.length).toBeLessThanOrEqual(2);
    const text = chapters.flatMap((c) => c.blocks.map((b) => ('text' in b ? b.text : ''))).join(' ');
    expect(text).toContain('Um capítulo de verdade');
    // Nenhum texto se perde: as letras continuam no livro.
    expect(text).toMatch(/\bF\b/);
    expect(text).toMatch(/\bA\b/);
  });

  it('capítulos curtos isolados continuam separados', () => {
    const titulo = (p: number, t: string) =>
      page(p, [item(t, 60, 720, 24, 300), item('Texto curto do capítulo.', 60, 680, 12, 200)]);
    const chapters = extractPdfChapters([titulo(1, 'Primeiro'), titulo(2, 'Segundo')]);
    expect(chapters.map((c) => c.title)).toEqual(['Primeiro', 'Segundo']);
  });
});
