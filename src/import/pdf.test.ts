import { describe, expect, it, vi } from 'vitest';
import {
  buildBookPdf,
  buildPasswordPdf,
  buildScannedPdf,
  buildSlidesPdf,
  buildZeroPagesPdf,
} from '../../test/fixtures/pdf-fixtures';
import { parsePdf } from './pdf';

// O pdf.js "normal" depende de APIs de navegador; nos testes usamos a build legacy, que roda no Node.
vi.mock('pdfjs-dist', async () => await import('pdfjs-dist/legacy/build/pdf.mjs'));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const noop = () => {};

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('parsePdf (sem canvas, no Node)', () => {
  it('converte um livro de texto em capítulos refluíveis', async () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Parágrafo número ${i + 1} do livro de teste, com acentuação e bastante texto para formar linhas completas na página.`,
    );
    const bytes = await buildBookPdf({ paragraphs, headings: [{ before: 0, text: 'Início da Obra', size: 22 }] });
    const book = await parsePdf(toBuffer(bytes), 'meu_livro_teste.pdf', noop);
    expect(book.title).toBe('meu livro teste');
    expect(book.fixedLayout).toBeUndefined();
    expect(book.chapters[0].title).toBe('Início da Obra');
    expect(book.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'p')).toHaveLength(10);
  });

  it('PDF de slides vira capítulos de ~10 slides com o texto de cada um', async () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ title: `Tema ${i + 1}`, lines: ['primeiro ponto importante do tema', 'segundo ponto importante do tema'] }));
    const progress: number[] = [];
    const book = await parsePdf(toBuffer(await buildSlidesPdf(slides)), 'aula.pdf', (f) => progress.push(f));
    expect(book.fixedLayout).toBeUndefined();
    expect(book.chapters.map((c) => c.title)).toEqual(['Tema 1', 'Tema 11']);
    expect(book.chapters[1].blocks.some((b) => b.t === 'p' && b.text === 'Tema 12')).toBe(true);
    expect(book.chapters.flatMap((c) => c.blocks).some((b) => b.t === 'h')).toBe(false);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('PDF escaneado sem canvas devolve fixedLayout com aviso', async () => {
    const book = await parsePdf(toBuffer(await buildScannedPdf(4)), 'scan.pdf', noop);
    expect(book.fixedLayout).toBe(true);
    expect(book.warnings?.[0]).toMatch(/escaneado/);
    expect(book.chapters).toEqual([]);
  });

  it('PDF com senha lança "PDF protegido por senha"', async () => {
    await expect(parsePdf(toBuffer(buildPasswordPdf()), 'x.pdf', noop)).rejects.toThrow('PDF protegido por senha');
  });

  it('PDF corrompido lança erro legível em português', async () => {
    const bad = new TextEncoder().encode('%PDF-1.7 lixo lixo lixo');
    await expect(parsePdf(toBuffer(bad), 'x.pdf', noop)).rejects.toThrow(/PDF|corrompido/);
  });

  it('PDF de 0 páginas lança erro legível', async () => {
    await expect(parsePdf(toBuffer(buildZeroPagesPdf()), 'x.pdf', noop)).rejects.toThrow(/páginas|corrompido|PDF/);
  });
});
