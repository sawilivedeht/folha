// Gera as fixtures dos testes E2E (sem binários versionados). Chamado pelo globalSetup.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.generated');

const PALAVRAS = (
  'a casa antiga ficava no alto da colina onde o vento soprava forte durante as tardes de outono ' +
  'enquanto maria atravessava o jardim silencioso lembrando das histórias que o avô contava sobre ' +
  'navegações distantes tempestades imprevisíveis e ações heroicas realizadas por pessoas simples ' +
  'cujas vidas inteiras cabiam numa conversa ao redor da mesa coração canção solidão exceção ' +
  'maravilhosamente incompreensível extraordinariamente responsabilidade hipopotomonstrosesquipedaliofobia'
).split(' ');

/** Gerador pseudoaleatório determinístico. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function frase(r, min = 8, max = 22) {
  const n = min + Math.floor(r() * (max - min));
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(PALAVRAS[Math.floor(r() * PALAVRAS.length)]);
  const t = ws.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

function paragrafo(r, frases = 4) {
  const fs = [];
  const n = 2 + Math.floor(r() * frases);
  for (let i = 0; i < n; i++) fs.push(frase(r));
  return fs.join(' ');
}

function textoLongo() {
  const r = rng(42);
  // Quatro capítulos: três longos (~290 mil caracteres) e um curto (para percorrer todas as páginas).
  const tamanhos = [110_000, 100_000, 80_000, 12_000];
  const partes = ['O Grande Livro de Teste', ''];
  tamanhos.forEach((alvo, idx) => {
    partes.push(`Capítulo ${idx + 1}`, '');
    let n = 0;
    while (n < alvo) {
      const p = paragrafo(r, 6);
      partes.push(p, '');
      n += p.length + 2;
    }
  });
  return partes.join('\n');
}

function textoGigante() {
  const longa = 'Supercalifragilisticoespialidoso'.repeat(8);
  const url = 'https://exemplo.com.br/' + 'caminho-muito-longo/'.repeat(10) + 'arquivo.html?consulta=' + 'x'.repeat(120);
  const semEspaco = 'A'.repeat(500) + 'B'.repeat(500);
  const r = rng(7);
  return [
    'Texto com Palavras Gigantes',
    '',
    'Capítulo 1',
    '',
    'Palavra gigante: ' + longa + ' e depois um texto normal que continua por algum tempo. ' + paragrafo(r),
    '',
    url,
    '',
    semEspaco,
    '',
    paragrafo(r),
    '',
    'Capítulo 2',
    '',
    'Outra: ' + longa + longa,
    '',
    'http://' + 'a'.repeat(300) + '.com/' + 'b'.repeat(200),
    '',
    Array.from({ length: 12 }, () => paragrafo(r)).join('\n\n'),
    '',
  ].join('\n');
}

// --- PNG sintético (sem dependências) ---
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(w, h, cor = [180, 90, 40]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const xadrez = ((x >> 4) + (y >> 4)) & 1;
      raw[o + 1 + x * 3] = xadrez ? cor[0] : 255 - cor[0];
      raw[o + 2 + x * 3] = xadrez ? cor[1] : 255 - cor[1];
      raw[o + 3 + x * 3] = (cor[2] + y) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- EPUB ---
const XHTML = (titulo, corpo) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.w3.org/1999/xhtml" lang="pt-BR"><head><meta charset="utf-8"/><title>${titulo}</title></head><body>${corpo}</body></html>`;

function zipEpub(arquivos) {
  const obj = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [k, v] of Object.entries(arquivos)) obj[k] = typeof v === 'string' ? strToU8(v) : v;
  return Buffer.from(zipSync(obj));
}

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

function epub3() {
  const r = rng(11);
  const ps = (n) => Array.from({ length: n }, () => `<p>${paragrafo(r, 5)}</p>`).join('');
  const cap1 =
    `<h1>A casa na colina</h1>` +
    ps(10) +
    `<p>Texto com <em>itálico enfático</em>, <strong>negrito forte</strong> e <strong><em>ambos juntos</em></strong> no meio da frase.</p>` +
    `<figure><img src="img/ilustracao.png" alt="Ilustração alta"/></figure>` +
    ps(6) +
    `<ul><li>Primeiro item da lista com texto um pouco mais comprido para quebrar linha</li><li>Segundo item</li><li>Terceiro item</li></ul>` +
    `<ol><li>Passo um</li><li>Passo dois</li></ol>` +
    `<table><tr><th>Coluna A</th><th>Coluna B</th></tr><tr><td>Valor 1</td><td>Valor 2</td></tr><tr><td>Valor 3</td><td>Valor 4</td></tr></table>` +
    ps(8);
  const cap2 =
    `<h1>Segundo capítulo</h1>` +
    ps(6) +
    `<h2>Subtítulo da seção com um nome razoavelmente comprido</h2>` +
    `<p>Nota de rodapé<sup>1</sup> no meio do texto e <em>ênfase</em> em seguida.</p>` +
    `<pre>function exemplo(parametroComNomeMuitoLongo, outroParametroTambemLongo) { return parametroComNomeMuitoLongo + outroParametroTambemLongo; }</pre>` +
    `<hr/>` +
    `<h3>Seção menor</h3>` +
    ps(8) +
    `<blockquote><p>${paragrafo(r, 3)}</p></blockquote>` +
    ps(10);
  const cap3 = `<h1>Terceiro capítulo</h1>` + ps(16);
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:folha-e2e-3</dc:identifier><dc:title>Livro EPUB Três</dc:title><dc:creator>Autora Exemplar</dc:creator><dc:language>pt-BR</dc:language><meta name="cover" content="capa"/></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/><item id="img1" href="img/ilustracao.png" media-type="image/png"/><item id="capa" href="img/capa.png" media-type="image/png" properties="cover-image"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`;
  const nav = XHTML(
    'Sumário',
    `<nav epub:type="toc"><ol><li><a href="c1.xhtml">A casa na colina</a></li><li><a href="c2.xhtml">Segundo capítulo</a></li><li><a href="c3.xhtml">Terceiro capítulo</a></li></ol></nav>`,
  );
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/c1.xhtml': XHTML('c1', cap1),
    'OEBPS/c2.xhtml': XHTML('c2', cap2),
    'OEBPS/c3.xhtml': XHTML('c3', cap3),
    'OEBPS/img/ilustracao.png': new Uint8Array(makePng(300, 900)),
    'OEBPS/img/capa.png': new Uint8Array(makePng(200, 300, [30, 90, 160])),
  });
}

function epub2() {
  const r = rng(23);
  const ps = (n) => Array.from({ length: n }, () => `<p>${paragrafo(r, 5)}</p>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">folha-e2e-2</dc:identifier><dc:title>Livro EPUB Dois</dc:title><dc:creator>Zeca Antigo</dc:creator><dc:language>pt</dc:language></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Livro EPUB Dois</text></docTitle><navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>Parte Alfa</text></navLabel><content src="a.xhtml"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>Parte Beta</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>`;
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/toc.ncx': ncx,
    'OEBPS/a.xhtml': XHTML('a', `<h1>Parte Alfa</h1>${ps(12)}`),
    'OEBPS/b.xhtml': XHTML('b', `<h1>Parte Beta</h1>${ps(12)}`),
  });
}

// --- PDF ---
async function pdfTexto() {
  const doc = await PDFDocument.create();
  doc.setTitle('PDF de Texto');
  doc.setAuthor('Pedro Documento');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const r = rng(99);
  const W = 595;
  const H = 842;
  const size = 12;
  const lh = 16;
  const maxW = W - 120;
  const quebrar = (txt) => {
    const linhas = [];
    let atual = '';
    for (const w of txt.split(' ')) {
      const t = atual ? atual + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW) {
        linhas.push(atual);
        atual = w;
      } else atual = t;
    }
    if (atual) linhas.push(atual);
    return linhas;
  };
  for (let p = 0; p < 8; p++) {
    const page = doc.addPage([W, H]);
    let y = H - 70;
    if (p === 0) {
      page.drawText('Introdução ao Documento', { x: 60, y, size: 20, font });
      y -= 40;
    }
    while (y > 80) {
      for (const l of quebrar(paragrafo(r, 5))) {
        if (y < 80) break;
        page.drawText(l, { x: 60, y, size, font });
        y -= lh;
      }
      y -= 10;
    }
  }
  return Buffer.from(await doc.save());
}

async function pdfEscaneado() {
  const doc = await PDFDocument.create();
  doc.setTitle('PDF Escaneado');
  for (let i = 0; i < 3; i++) {
    const img = await doc.embedPng(makePng(300, 420, [60 + i * 50, 120, 200 - i * 40]));
    const page = doc.addPage([300, 420]);
    page.drawImage(img, { x: 0, y: 0, width: 300, height: 420 });
  }
  return Buffer.from(await doc.save());
}

/** Gera todas as fixtures em FIXTURE_DIR e devolve os caminhos. */
export async function gerarFixtures(dir = FIXTURE_DIR) {
  mkdirSync(dir, { recursive: true });
  const saida = {};
  const gravar = (nome, dados) => {
    const p = join(dir, nome);
    writeFileSync(p, dados);
    saida[nome] = p;
  };
  gravar('longo.txt', textoLongo());
  gravar('gigante.txt', textoGigante());
  gravar('epub3.epub', epub3());
  gravar('epub2.epub', epub2());
  gravar('texto.pdf', await pdfTexto());
  gravar('escaneado.pdf', await pdfEscaneado());
  gravar('corrompido.pdf', Buffer.from('%PDF-1.4\nisto nao e um pdf valido\n%%EOF\n'));
  gravar('invalido.docx', Buffer.from('PK\x03\x04conteudo falso de docx'));
  // Livros pequenos para testes de biblioteca (ordenação, busca com mais de 8 livros).
  for (let i = 1; i <= 10; i++) {
    const r = rng(1000 + i);
    gravar(`mini-${i}.txt`, `Livro ${String.fromCharCode(64 + i)}${i}\n\nCapítulo 1\n\n${paragrafo(r, 4)}\n\n${paragrafo(r, 4)}\n\nCapítulo 2\n\n${paragrafo(r, 4)}\n`);
  }
  return saida;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await gerarFixtures();
  console.log(Object.keys(r).join('\n'));
}
