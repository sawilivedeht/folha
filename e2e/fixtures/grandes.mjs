// Fixtures grandes para os testes de desempenho e memória (geradas em memória; nada é versionado).
import { zipSync, strToU8 } from 'fflate';
import { makePng } from './make.mjs';

const PALAVRAS = (
  'a casa antiga ficava no alto da colina onde o vento soprava forte durante as tardes de outono ' +
  'enquanto maria atravessava o jardim silencioso lembrando das histórias que o avô contava sobre ' +
  'navegações distantes tempestades imprevisíveis e ações heroicas realizadas por pessoas simples'
).split(' ');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function paragrafo(r, palavras = 70) {
  const ws = [];
  for (let i = 0; i < palavras; i++) ws.push(PALAVRAS[Math.floor(r() * PALAVRAS.length)]);
  const t = ws.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

/** TXT com ~`bytes` bytes, dividido em capítulos "Capítulo N". */
export function txtGrande(bytes = 5 * 1024 * 1024) {
  const r = rng(5);
  const partes = ['Livro Enorme de Teste', ''];
  let n = 0;
  let cap = 0;
  while (n < bytes) {
    if (n === 0 || cap * 100_000 < n) {
      cap++;
      partes.push(`Capítulo ${cap}`, '');
    }
    const p = paragrafo(r);
    partes.push(p, '');
    n += Buffer.byteLength(p) + 2;
  }
  return Buffer.from(partes.join('\n'), 'utf8');
}

const XHTML = (corpo) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="pt-BR"><head><meta charset="utf-8"/><title>c</title></head><body>${corpo}</body></html>`;
const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

function montarEpub(titulo, capitulos, imagens) {
  const obj = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  obj['META-INF/container.xml'] = strToU8(CONTAINER);
  const manifest = [];
  const spine = [];
  const lis = [];
  capitulos.forEach((corpo, i) => {
    obj[`OEBPS/c${i}.xhtml`] = strToU8(XHTML(corpo));
    manifest.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    lis.push(`<li><a href="c${i}.xhtml">Capítulo ${i + 1}</a></li>`);
  });
  imagens.forEach((buf, i) => {
    obj[`OEBPS/img/i${i}.png`] = new Uint8Array(buf);
    manifest.push(`<item id="i${i}" href="img/i${i}.png" media-type="image/png"/>`);
  });
  obj['OEBPS/nav.xhtml'] = strToU8(XHTML(`<nav epub:type="toc"><ol>${lis.join('')}</ol></nav>`));
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  obj['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${titulo.replace(/\W/g, '')}</dc:identifier><dc:title>${titulo}</dc:title><dc:creator>Autor Sintético</dc:creator><dc:language>pt-BR</dc:language></metadata>
<manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return Buffer.from(zipSync(obj));
}

/** EPUB com `capitulos` capítulos e `imagens` imagens (uma por capítulo, nos primeiros capítulos). */
export function epubGrande(capitulos = 300, imagens = 200) {
  const r = rng(9);
  const pngs = [];
  for (let i = 0; i < imagens; i++) pngs.push(makePng(240 + (i % 4) * 20, 320, [(i * 37) % 255, (i * 91) % 255, 120]));
  const corpos = [];
  for (let c = 0; c < capitulos; c++) {
    let corpo = `<h1>Capítulo ${c + 1}</h1>`;
    for (let p = 0; p < 12; p++) corpo += `<p>${paragrafo(r, 80)}</p>`;
    if (c < imagens) corpo += `<figure><img src="img/i${c}.png" alt="Figura ${c + 1}"/></figure>`;
    corpos.push(corpo);
  }
  return montarEpub('Epub Gigante de Teste', corpos, pngs);
}

/** EPUB com um único capítulo de ~`chars` caracteres. */
export function epubCapituloUnico(chars = 400_000) {
  const r = rng(13);
  let corpo = '<h1>Capítulo Único</h1>';
  let n = 0;
  while (n < chars) {
    const p = paragrafo(r, 90);
    corpo += `<p>${p}</p>`;
    n += p.length;
  }
  return montarEpub('Capitulo Unico de Teste', [corpo], []);
}

/** EPUB com conteúdo hostil ao layout: palavras/URLs enormes, imagem altíssima, pre largo, emojis, RTL, CJK. */
export function epubHostil() {
  const r = rng(21);
  const longa = 'Supercalifragilisticoespialidoso'.repeat(12);
  const url = 'https://exemplo.com.br/' + 'caminho-muito-longo/'.repeat(15) + 'arquivo.html?consulta=' + 'x'.repeat(200);
  const corpo =
    `<h1>Conteúdo hostil</h1>` +
    `<p>Palavra: ${longa} fim. ${paragrafo(r, 30)}</p>` +
    `<p>${url}</p>` +
    `<p>${'A'.repeat(900)}</p>` +
    `<h2>${'Título'.repeat(60)}</h2>` +
    `<pre>${'0123456789 '.repeat(80)}\nsegunda linha curta</pre>` +
    `<figure><img src="img/i0.png" alt="Imagem muito alta"/></figure>` +
    `<p>${paragrafo(r, 40)}</p>` +
    `<p>Emojis: 😀😃😄😁😆 👨‍👩‍👧‍👦 🏳️‍🌈 ❤️ ${'🎉'.repeat(60)} fim.</p>` +
    `<p dir="rtl">مرحبا بكم في هذا الكتاب التجريبي الذي يحتوي على نص عربي طويل لاختبار الاتجاه من اليمين إلى اليسار ${'كتاب '.repeat(40)}</p>` +
    `<p dir="rtl">שלום עולם, זהו טקסט בעברית לבדיקת כיוון הכתיבה מימין לשמאל ${'ספר '.repeat(40)}</p>` +
    `<p>日本語のテキストです。これは長い文章で、単語の区切りがありません。${'吾輩は猫である。名前はまだ無い。'.repeat(20)}</p>` +
    `<p>中文文本测试，这是一个没有空格的很长的句子。${'床前明月光，疑是地上霜。'.repeat(20)}</p>` +
    `<p>한국어 텍스트 테스트입니다. ${'동해물과 백두산이 마르고 닳도록 '.repeat(15)}</p>` +
    `<p>${paragrafo(r, 60)}</p>`;
  return montarEpub('Livro Hostil de Teste', [corpo], [makePng(200, 6000, [20, 120, 200])]);
}
