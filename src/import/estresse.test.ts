// Estresse dos importadores: arquivos grandes. Os casos que passam de ~5 s só rodam com
// `ESTRESSE=1 npx vitest run src/import/estresse.test.ts` (imprime tempo e memória de cada um).
import { strToU8, zipSync } from 'fflate';
import { Window } from 'happy-dom';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildEpub, png, xhtmlDoc } from '../../test/fixtures/epub-fixtures';
import { checarLivro } from '../../test/fixtures/fuzz';
import { convertPdfBytes } from '../../test/fixtures/pdf-node';
import { parseEpub } from './epub';
import { buildMeta } from './index';
import { decodeText, parseTxt } from './txt';

const ESTRESSE = Boolean(process.env.ESTRESSE);
const noop = () => {};

function medir<T>(nome: string, fn: () => Promise<T> | T): Promise<{ r: T; ms: number; rssMB: number; heapMB: number }> {
  return (async () => {
    globalThis.gc?.();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    const m = process.memoryUsage();
    const out = { r, ms, rssMB: Math.round((m.rss - rss0) / 1048576), heapMB: Math.round(m.heapUsed / 1048576) };
    if (ESTRESSE) process.stderr.write(`[estresse] ${nome}: ${ms} ms, +${out.rssMB} MB de RSS, heap ${out.heapMB} MB\n`);
    return out;
  })();
}

function parseDocumentHappy(janela: Window) {
  return (html: string): Document => {
    const parser = new janela.DOMParser();
    try {
      const x = parser.parseFromString(html, 'application/xhtml+xml');
      if (x.getElementsByTagName('parsererror').length === 0) return x as unknown as Document;
    } catch {
      // cai para HTML
    }
    return parser.parseFromString(html, 'text/html') as unknown as Document;
  };
}

async function converterEpub(bytes: Uint8Array) {
  const janela = new Window();
  try {
    return await parseEpub(bytes.slice().buffer, 'grande.epub', noop, { parseDocument: parseDocumentHappy(janela) });
  } finally {
    await janela.happyDOM.close();
  }
}

/** Um parágrafo de ~12 KB sem quebras de linha de 80 colunas, para engordar o TXT rapidamente. */
function textoGrande(bytes: number, comCapitulos: boolean): Uint8Array {
  const frase = 'A leitura em telas pequenas exige tipografia cuidadosa, margens generosas e atenção ao ritmo do texto. ';
  const para = frase.repeat(8).trim();
  const partes: string[] = [];
  let tam = 0;
  let n = 0;
  while (tam < bytes) {
    if (comCapitulos && n % 200 === 0) partes.push(`CAPÍTULO ${n / 200 + 1}\n`);
    partes.push(`${para}\n\n`);
    tam += para.length + 2;
    n++;
  }
  return strToU8(partes.join(''));
}

describe('estresse: TXT', () => {
  it('2 MB sem capítulos: fatias de 40 mil caracteres', async () => {
    const bytes = textoGrande(2 * 1048576, false);
    const { r, ms } = await medir('txt 2 MB', () => parseTxt(decodeText(bytes.slice().buffer), 'grande.txt'));
    checarLivro(r, 'txt-2MB');
    expect(r.chapters.length).toBeGreaterThan(40);
    expect(ms).toBeLessThan(5000);
  });

  describe.skipIf(!ESTRESSE)('20 MB', () => {
    it('sem capítulos', async () => {
      const bytes = textoGrande(20 * 1048576, false);
      const { r } = await medir('txt 20 MB sem capítulos', () => parseTxt(decodeText(bytes.slice().buffer), 'grande.txt'));
      checarLivro(r, 'txt-20MB');
      const meta = buildMeta(r, { fileName: 'grande.txt', format: 'txt' }, 'id', 0);
      expect(meta.totalChars).toBeGreaterThan(15_000_000);
    }, 120_000);

    it('linhas curtas (meio milhão de blocos)', async () => {
      const linha = 'linha curta de texto corrido número ';
      const partes: string[] = [];
      for (let i = 0; partes.length * 40 < 20 * 1048576; i++) partes.push(`${linha}${i}`);
      const bytes = strToU8(partes.join('\n'));
      const { r } = await medir('txt 20 MB linhas curtas', () => parseTxt(decodeText(bytes.slice().buffer), 'grande.txt'));
      checarLivro(r, 'txt-20MB-linhas');
      const blocos = r.chapters.reduce((n, c) => n + c.blocks.length, 0);
      expect(blocos).toBeGreaterThan(400_000);
    }, 120_000);

    it('com ~130 capítulos', async () => {
      const bytes = textoGrande(20 * 1048576, true);
      const { r } = await medir('txt 20 MB com capítulos', () => parseTxt(decodeText(bytes.slice().buffer), 'grande.txt'));
      checarLivro(r, 'txt-20MB-caps');
      expect(r.chapters.length).toBeGreaterThan(100);
    }, 120_000);
  });
});

describe('estresse: EPUB', () => {
  it('300 capítulos pequenos', async () => {
    const chapters = Array.from({ length: 300 }, (_, i) => ({ file: `c${i}.xhtml`, xhtml: xhtmlDoc(`<h1>Capítulo ${i + 1}</h1><p>Texto do capítulo ${i + 1} com acentuação: ação.</p>`) }));
    const bytes = buildEpub({ chapters, toc: chapters.map((c, i) => ({ file: c.file, title: `Título ${i + 1}` })) });
    const { r, ms } = await medir('epub 300 capítulos', () => converterEpub(bytes));
    checarLivro(r, 'epub-300');
    expect(r.chapters).toHaveLength(300);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  describe.skipIf(!ESTRESSE)('grandes', () => {
    it('2.000 capítulos', async () => {
      const chapters = Array.from({ length: 2000 }, (_, i) => ({ file: `c${i}.xhtml`, xhtml: xhtmlDoc(`<h1>Capítulo ${i + 1}</h1><p>Texto do capítulo ${i + 1}.</p><p>Mais um parágrafo.</p>`) }));
      const bytes = buildEpub({ chapters, toc: chapters.map((c, i) => ({ file: c.file, title: `Título ${i + 1}` })) });
      const { r } = await medir('epub 2000 capítulos', () => converterEpub(bytes));
      checarLivro(r, 'epub-2000');
      expect(r.chapters).toHaveLength(2000);
    }, 120_000);

    it('500 imagens', async () => {
      const extra: Record<string, Uint8Array> = {};
      const chapters = Array.from({ length: 50 }, (_, c) => {
        const imgs = Array.from({ length: 10 }, (_, k) => {
          const n = c * 10 + k;
          extra[`Images/i${n}.png`] = png(n % 256, (n * 7) % 256, (n * 13) % 256);
          return `<p><img src="Images/i${n}.png" alt="figura ${n}"/></p>`;
        }).join('');
        return { file: `c${c}.xhtml`, xhtml: xhtmlDoc(`<h1>Capítulo ${c + 1}</h1><p>Texto.</p>${imgs}`) };
      });
      const bytes = buildEpub({ chapters, extra });
      const { r } = await medir('epub 500 imagens', () => converterEpub(bytes));
      checarLivro(r, 'epub-500-imagens');
      expect(r.images.size).toBe(500);
    }, 120_000);

    it('imagem repetida 500 vezes usa uma só entrada', async () => {
      const imgs = Array.from({ length: 500 }, () => '<p><img src="Images/a.png"/></p>').join('');
      const bytes = buildEpub({
        chapters: [{ file: 'c.xhtml', xhtml: xhtmlDoc(`<h1>Único</h1>${imgs}`) }],
        extra: { 'Images/a.png': png() },
      });
      const { r } = await medir('epub imagem repetida', () => converterEpub(bytes));
      checarLivro(r, 'epub-repetida');
      expect(r.images.size).toBe(1);
    }, 60_000);
  });

  it('bomba de zip: entrada de 200 MB de zeros compactada é recusada com mensagem clara', async () => {
    // 200 MB de zeros comprimem para ~200 KB; sem limite, o importador descompactaria tudo na memória.
    const grande = new Uint8Array(200 * 1048576);
    const epub = zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
      'c.opf': strToU8('<package><metadata><dc:title>x</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'),
      'a.xhtml': strToU8(xhtmlDoc('<p>Olá</p>')),
      'lixo.bin': grande,
    });
    expect(epub.length).toBeLessThan(1_000_000);
    const inicio = performance.now();
    await expect(converterEpub(epub)).rejects.toThrow(/grande demais.*512 MB/);
    expect(performance.now() - inicio).toBeLessThan(10_000);
    expect(process.memoryUsage().rss).toBeLessThan(2 * 1024 * 1024 * 1024);
  }, 60_000);
});

async function pdfGrande(paginas: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const linha = 'A leitura em telas pequenas exige tipografia cuidadosa e margens generosas para o leitor.';
  for (let p = 0; p < paginas; p++) {
    const pg = doc.addPage([420, 595]);
    if (p % 25 === 0) pg.drawText(`Capítulo ${p / 25 + 1}`, { x: 55, y: 520, size: 22, font: negrito });
    let y = 490;
    for (let i = 0; i < 28; i++) {
      pg.drawText(linha, { x: 55, y, size: 11, font: fonte });
      y -= 16;
    }
    pg.drawText(String(p + 1), { x: 205, y: 30, size: 9, font: fonte });
  }
  return doc.save();
}

describe('estresse: PDF', () => {
  it('50 páginas de texto', async () => {
    const bytes = await pdfGrande(50);
    const { r, ms } = await medir('pdf 50 páginas', () => convertPdfBytes(bytes));
    expect(r.numPages).toBe(50);
    expect(r.chapters.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15_000);
  }, 60_000);

  describe.skipIf(!ESTRESSE)('grande', () => {
    it('500 páginas de texto', async () => {
      const bytes = await pdfGrande(500);
      const { r } = await medir('pdf 500 páginas', () => convertPdfBytes(bytes));
      expect(r.numPages).toBe(500);
      const chars = r.chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + ('text' in b ? b.text.length : 0), 0), 0);
      expect(chars).toBeGreaterThan(500 * 28 * 60);
      expect(r.chapters.length).toBeGreaterThanOrEqual(15);
    }, 300_000);
  });
});
