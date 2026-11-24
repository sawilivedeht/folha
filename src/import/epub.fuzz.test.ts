// @vitest-environment happy-dom
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, png, xhtmlDoc } from '../../test/fixtures/epub-fixtures';
import { fuzzRuns, fuzzSeed, mulberry32, mutateBytes, mutateText, randomXhtml, verificarConversao, type Rng } from '../../test/fixtures/fuzz';
import { parseEpub } from './epub';

const noop = () => {};
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

/**
 * Mesmo comportamento do `defaultParseDocument` do app, mas tolerante a um defeito do happy-dom:
 * o parser dele lança DOMException em HTML com `<html>`/`<body>` aninhados, coisa que o DOMParser
 * de um navegador real nunca faz (ele sempre devolve um documento).
 */
function parseDocument(html: string): Document {
  const parser = new DOMParser();
  try {
    const xhtml = parser.parseFromString(html, 'application/xhtml+xml');
    if (xhtml.getElementsByTagName('parsererror').length === 0) return xhtml;
  } catch {
    // cai para o parser de HTML
  }
  try {
    return parser.parseFromString(html, 'text/html');
  } catch {
    return parser.parseFromString('', 'text/html');
  }
}
const parse = (u: Uint8Array) => () => parseEpub(toBuf(u), 'livro.epub', noop, { parseDocument });

function epubBase(): Uint8Array {
  return buildEpub({
    version: 3,
    cover: 'properties',
    chapters: [
      {
        file: 'cap1.xhtml',
        xhtml: xhtmlDoc('<h1>Capítulo 1</h1><p>Texto com <b>negrito</b> e <i>itálico</i>, ação e coração.</p><p><img src="Images/f.png" alt="figura"/></p><ul><li>um</li><li>dois</li></ul>'),
      },
      { file: 'cap2.xhtml', xhtml: xhtmlDoc('<h2>Capítulo 2</h2><blockquote>Citação.</blockquote><pre>código</pre><hr/><p>Fim.</p>') },
      { file: 'cap3.xhtml', xhtml: xhtmlDoc('<p>Sem título.<br/>Outra linha.</p><table><tr><td>a</td></tr></table>') },
    ],
    toc: [
      { file: 'cap1.xhtml', title: 'Um' },
      { file: 'cap2.xhtml', title: 'Dois' },
    ],
    extra: { 'Images/f.png': png() },
  });
}

/** Mutações no nível do zip: troca o conteúdo de uma entrada e recompacta. */
function mutarEntrada(base: Uint8Array, rng: Rng): Uint8Array {
  const files = unzipSync(base);
  const nomes = Object.keys(files);
  const alvo = rng.pick(nomes);
  const preferidas = nomes.filter((n) => /mimetype|container\.xml|\.opf$|\.xhtml$|\.png$/.test(n));
  const nome = rng.chance(0.8) && preferidas.length ? rng.pick(preferidas) : alvo;
  switch (rng.int(5)) {
    case 0:
      delete files[nome];
      break;
    case 1:
      files[nome] = new Uint8Array(0);
      break;
    case 2:
      files[nome] = mutateBytes(files[nome], rng, 4);
      break;
    case 3:
      files[nome] = strToU8(mutateText(strFromU8(files[nome]), rng));
      break;
    default:
      files[nome] = strToU8(randomXhtml(rng));
  }
  return zipSync(files);
}

function epubComCapitulosAleatorios(rng: Rng): Uint8Array {
  const n = rng.range(0, 6);
  const chapters = Array.from({ length: n }, (_, i) => ({ file: `c${i}.xhtml`, xhtml: randomXhtml(rng) }));
  return buildEpub({
    version: rng.chance(0.5) ? 2 : 3,
    chapters,
    toc: chapters.map((c, i) => ({ file: c.file, title: `T${i}` })),
    extra: { 'a.png': png(), 'b.png': png(1, 2, 3) },
  });
}

describe('EPUB: fuzzing com semente fixa', () => {
  const base = epubBase();

  it('o EPUB base é válido (controle)', async () => {
    const r = await verificarConversao(parse(base), 'base');
    expect(r.ok).toBe(true);
  });

  it('bytes do zip corrompidos: erro amigável ou livro válido', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x1001);
    const n = fuzzRuns(200);
    let erros = 0;
    for (let i = 0; i < n; i++) {
      const bytes = mutateBytes(base, rng, 8);
      const r = await verificarConversao(parse(bytes), `epub-zip#${i}`);
      if (!r.ok) erros++;
    }
    expect(erros).toBeGreaterThan(0);
  });

  it('zip truncado em qualquer ponto: erro amigável ou livro válido', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x1002);
    const n = fuzzRuns(100);
    for (let i = 0; i < n; i++) {
      const corte = rng.int(base.length);
      await verificarConversao(parse(base.slice(0, corte)), `epub-trunc#${corte}`);
    }
    await verificarConversao(parse(new Uint8Array(0)), 'epub-vazio');
  });

  it('entradas internas (mimetype, container, OPF, XHTML, imagem) corrompidas ou removidas', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x1003);
    const n = fuzzRuns(250);
    for (let i = 0; i < n; i++) {
      const bytes = mutarEntrada(base, rng);
      await verificarConversao(parse(bytes), `epub-entrada#${i}`);
    }
  });

  it('XHTML aleatório e tags embaralhadas nos capítulos', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x1004);
    const n = fuzzRuns(200);
    for (let i = 0; i < n; i++) {
      const bytes = epubComCapitulosAleatorios(rng);
      await verificarConversao(parse(bytes), `epub-xhtml#${i}`);
    }
  });

  it('não-EPUB (lixo, PDF, texto) vira erro amigável', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x1005);
    const n = fuzzRuns(60);
    for (let i = 0; i < n; i++) {
      const lixo = Uint8Array.from({ length: rng.range(0, 3000) }, () => rng.int(256));
      const r = await verificarConversao(parse(lixo), `epub-lixo#${i}`);
      expect(r.ok).toBe(false);
    }
  });
});
