// Fuzzing do caminho de extração de PDF (o mesmo de `scripts/convert-pdf.mjs`, no Node).
// O `parsePdf` do navegador usa o mesmo núcleo, mas depende de worker e canvas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBookPdf,
  buildListAndStylesPdf,
  buildScannedPdf,
  buildSlidesPdf,
  buildTextWithFigurePdf,
  buildTwoColumnPdf,
  buildZeroPagesPdf,
} from '../../test/fixtures/pdf-fixtures';
import { convertPdfBytes } from '../../test/fixtures/pdf-node';
import { fuzzRuns, fuzzSeed, isolarRejeicoesDoPdfjs, mulberry32, mutateBytes, mutateText, verificarConversao, type Rng } from '../../test/fixtures/fuzz';
import type { ParsedBook } from '../types';

const PARAGRAFOS = [
  'A informação digital transformou profundamente a comunicação contemporânea, permitindo que pessoas colaborem em tempo real.',
  'Aplicações móveis modernas dependem de arquitetura bem planejada e de preocupação constante com desempenho e acessibilidade.',
  'A leitura em telas pequenas exige tipografia cuidadosa, margens generosas e espaçamento consistente para o leitor.',
];

/** PDF mínimo escrito à mão, com fluxo de conteúdo sem compressão (permite mutar os operadores). */
function pdfMinimo(conteudo: string, paginas = 1): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: paginas }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${paginas} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (let i = 0; i < paginas; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`);
  }
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

const CONTEUDO = 'BT /F1 12 Tf 50 520 Td (Primeira linha do texto de teste) Tj 0 -16 Td (Segunda linha com acentua\\347\\343o) Tj ET\nBT /F1 20 Tf 50 400 Td (TITULO) Tj ET';

const toBook = async (bytes: Uint8Array): Promise<ParsedBook> => {
  const r = await convertPdfBytes(bytes);
  // Sem canvas no Node: as imagens de página que o navegador renderizaria entram como blobs vazios.
  const images = new Map<string, Blob>();
  for (const ch of r.chapters) for (const b of ch.blocks) if (b.t === 'img') images.set(b.src, new Blob([]));
  return { title: r.title || 'sem título', chapters: r.chapters, images };
};

function conteudoAleatorio(rng: Rng): string {
  const ops = ['BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"', 'q', 'Q', 'cm', 're', 'f', 'W', 'n', 'Do', 'gs', 'BI', 'ID', 'EI', 'sh', 'Tc', 'Tw', 'Tz', 'TL', 'Tr', 'Ts'];
  const args = ['/F1', '/F2', '12', '-3.5', '1e99', '0', '999999999', '(texto)', '(a\\)b)', '<48656c6c6f>', '[(a) -200 (b)]', '<<', '>>', '[', ']', '(', ')', '/Im0', 'null', 'true'];
  const partes: string[] = [];
  const n = rng.range(0, 80);
  for (let i = 0; i < n; i++) partes.push(rng.chance(0.55) ? rng.pick(args) : rng.pick(ops));
  return partes.join(rng.chance(0.8) ? ' ' : '\n');
}

describe('PDF: fuzzing com semente fixa', () => {
  const isolamento = { atual: undefined as ReturnType<typeof isolarRejeicoesDoPdfjs> | undefined };
  beforeAll(() => {
    isolamento.atual = isolarRejeicoesDoPdfjs();
  });
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 20)); // deixa as rejeições pendentes do pdf.js chegarem
    isolamento.atual?.restaurar();
  });

  it('PDFs gerados são convertidos (controle)', async () => {
    const bytes = await buildBookPdf({ paragraphs: PARAGRAFOS, hyphenate: true, textWidth: 250 });
    const r = await verificarConversao(() => toBook(bytes), 'controle');
    expect(r.ok).toBe(true);
    const m = await verificarConversao(() => toBook(pdfMinimo(CONTEUDO)), 'controle-minimo');
    expect(m.ok).toBe(true);
  });

  it('regressão: página corrompida depois de abrir o documento vira erro em português', async () => {
    // Com uma mutação de 1 byte, o pdf.js ainda abre o documento (xref recuperada), mas falha ao
    // ler a página ("Bad (uncompressed) XRef entry"). Antes, esse erro cru escapava do importador.
    const base = await buildBookPdf({ paragraphs: ['Um parágrafo de teste com texto suficiente para a página.'] });
    const rng = mulberry32(7);
    let achou = 0;
    for (let i = 0; i < 120; i++) {
      const bytes = mutateBytes(base, rng, 1);
      const r = await verificarConversao(() => toBook(bytes), `pagina-corrompida#${i}`);
      if (!r.ok && !r.vazio && (r.erro as Error).message === 'Este arquivo PDF está corrompido ou incompleto.') achou++;
    }
    expect(achou).toBeGreaterThan(0);
  });

  it('bytes mutados de PDFs válidos: erro amigável ou livro válido', async () => {
    const sementes = [
      await buildBookPdf({ paragraphs: PARAGRAFOS, headings: [{ before: 1, text: 'Capítulo Dois' }] }),
      await buildSlidesPdf([{ title: 'Um', lines: ['a', 'b'] }, { title: 'Dois', lines: ['c'], figure: 0.5 }]),
      await buildScannedPdf(2),
      await buildTextWithFigurePdf(),
      await buildListAndStylesPdf(),
      await buildTwoColumnPdf(['esquerda um', 'esquerda dois'], ['direita um', 'direita dois']),
      pdfMinimo(CONTEUDO),
    ];
    const rng = mulberry32(fuzzSeed() ^ 0x2001);
    const n = fuzzRuns(200);
    let erros = 0;
    for (let i = 0; i < n; i++) {
      const bytes = mutateBytes(rng.pick(sementes), rng, 8);
      const r = await verificarConversao(() => toBook(bytes), `pdf-bytes#${i}`, { ms: 15000 });
      if (!r.ok) erros++;
    }
    expect(erros).toBeLessThan(n);
  });

  it('PDFs truncados em qualquer ponto: erro amigável ou livro válido', async () => {
    const bytes = await buildBookPdf({ paragraphs: PARAGRAFOS });
    const rng = mulberry32(fuzzSeed() ^ 0x2002);
    const n = fuzzRuns(60);
    for (let i = 0; i < n; i++) {
      const corte = rng.int(bytes.length);
      await verificarConversao(() => toBook(bytes.slice(0, corte)), `pdf-trunc#${corte}`, { ms: 15000 });
    }
    await verificarConversao(() => toBook(new Uint8Array(0)), 'pdf-vazio');
    await verificarConversao(() => toBook(new TextEncoder().encode('%PDF-1.7\n')), 'pdf-so-cabecalho');
    await verificarConversao(() => toBook(buildZeroPagesPdf()), 'pdf-zero-paginas');
  });

  it('fluxo de conteúdo com operadores embaralhados e mutados', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x2003);
    const n = fuzzRuns(200);
    for (let i = 0; i < n; i++) {
      const conteudo = rng.chance(0.5) ? mutateText(CONTEUDO, rng) : conteudoAleatorio(rng);
      // Só Latin-1: o PDF é escrito com `latin1` para manter os deslocamentos do xref corretos.
      const limpo = conteudo.replace(/[^\x20-\x7e\n]/g, '?');
      await verificarConversao(() => toBook(pdfMinimo(limpo, rng.range(1, 3))), `pdf-conteudo#${i}`, { ms: 15000 });
    }
  });

  it('não-PDF (lixo e texto) vira erro amigável', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x2004);
    const n = fuzzRuns(40);
    for (let i = 0; i < n; i++) {
      const bytes = Uint8Array.from({ length: rng.range(0, 2000) }, () => rng.int(256));
      if (bytes.length >= 8 && rng.chance(0.5)) bytes.set(new TextEncoder().encode('%PDF-1.4'), 0);
      await verificarConversao(() => toBook(bytes), `pdf-lixo#${i}`, { ms: 15000 });
    }
  });
});
