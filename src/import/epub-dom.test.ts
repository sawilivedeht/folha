// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, png, xhtmlDoc } from '../../test/fixtures/epub-fixtures';
import type { Block } from '../types';
import { htmlToBlocks } from './html-blocks';
import { parseEpub } from './epub';

const noop = () => {};
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;
const parse = (u: Uint8Array, name = 'livro.epub') => parseEpub(toBuf(u), name, noop);

function blocksOf(html: string, type: DOMParserSupportedType = 'text/html'): Block[] {
  const doc = new DOMParser().parseFromString(html, type);
  return htmlToBlocks(doc, { resolveImage: (src) => `img:${src}` });
}

describe('htmlToBlocks com DOM real (happy-dom)', () => {
  it('parágrafos, títulos e entidades HTML', () => {
    const blocks = blocksOf('<body><h1>Título &amp; Subtítulo</h1><p>caf&eacute; &mdash; a&nbsp;b &lt;tag&gt; &#233;</p><h5>Menor</h5></body>');
    expect(blocks[0]).toEqual({ t: 'h', level: 1, text: 'Título & Subtítulo' });
    expect(blocks[1]).toMatchObject({ t: 'p', text: expect.stringContaining('café — a') });
    expect((blocks[1] as { text: string }).text).toContain('<tag> é');
    expect(blocks[2]).toEqual({ t: 'h', level: 3, text: 'Menor' });
  });

  it('<br> vira quebra de linha dentro do parágrafo', () => {
    const [p] = blocksOf('<body><p>linha um<br/>linha dois<br>linha três</p></body>');
    expect(p).toMatchObject({ t: 'p', text: 'linha um\nlinha dois\nlinha três' });
  });

  it('negrito e itálico viram runs, inclusive aninhados', () => {
    const [p] = blocksOf('<body><p>um <b>negrito</b> e <em>itálico <strong>ambos</strong></em> fim</p></body>');
    expect(p.t).toBe('p');
    if (p.t !== 'p') return;
    expect(p.text).toBe('um negrito e itálico ambos fim');
    expect(p.runs).toEqual([
      { s: 'um ' },
      { s: 'negrito', b: 1 },
      { s: ' e ' },
      { s: 'itálico ', i: 1 },
      { s: 'ambos', b: 1, i: 1 },
      { s: ' fim' },
    ]);
  });

  it('sobrescrito vira run sup', () => {
    const [p] = blocksOf('<body><p>nota<sup>1</sup></p></body>');
    expect(p).toMatchObject({ t: 'p', runs: [{ s: 'nota' }, { s: '1', sup: 1 }] });
  });

  it('script, style, noscript e nav são ignorados', () => {
    const blocks = blocksOf(
      '<body><style>p{color:red}</style><script>alert("x")</script><nav><a href="#">menu</a></nav><noscript>sem js</noscript><p>só isto</p></body>',
    );
    expect(blocks).toEqual([{ t: 'p', text: 'só isto' }]);
  });

  it('listas aninhadas viram itens li na ordem, com ordered correto', () => {
    const blocks = blocksOf(
      '<body><ul><li>A<ol><li>A1</li><li>A2</li></ol></li><li>B</li></ul></body>',
    );
    expect(blocks).toEqual([
      { t: 'li', text: 'A', ordered: false },
      { t: 'li', text: 'A1', ordered: true },
      { t: 'li', text: 'A2', ordered: true },
      { t: 'li', text: 'B', ordered: false },
    ]);
  });

  it('tabelas viram uma linha de texto por <tr> com células separadas por "·"', () => {
    const blocks = blocksOf(
      '<body><table><tr><th>Nome</th><th>Idade</th></tr><tr><td>Ana</td><td>30</td></tr></table></body>',
    );
    expect(blocks).toEqual([
      { t: 'p', text: 'Nome · Idade' },
      { t: 'p', text: 'Ana · 30' },
    ]);
  });

  it('tabela aninhada não duplica linhas', () => {
    const blocks = blocksOf(
      '<body><table><tr><td>fora<table><tr><td>dentro</td></tr></table></td></tr></table></body>',
    );
    const texts = blocks.map((b) => ('text' in b ? b.text : ''));
    expect(texts.filter((t) => t.includes('dentro'))).toHaveLength(1);
  });

  it('imagens: src resolvido, alt e dimensões; svg com <image>', () => {
    const blocks = blocksOf(
      '<body><p>antes<img src="../Images/x.png" alt="Figura 1" width="100" height="50"/>depois</p><svg><image href="y.png" width="10" height="20"/></svg><img src="" /></body>',
    );
    expect(blocks[0]).toEqual({ t: 'p', text: 'antes' });
    expect(blocks[1]).toEqual({ t: 'img', src: 'img:../Images/x.png', alt: 'Figura 1', w: 100, h: 50 });
    expect(blocks[2]).toEqual({ t: 'p', text: 'depois' });
    expect(blocks[3]).toMatchObject({ t: 'img', src: 'img:y.png', w: 10, h: 20 });
    expect(blocks).toHaveLength(4);
  });

  it('imagem que não resolve é descartada', () => {
    const doc = new DOMParser().parseFromString('<body><img src="http://x/y.png"/><p>ok</p></body>', 'text/html');
    const blocks = htmlToBlocks(doc, { resolveImage: () => undefined });
    expect(blocks).toEqual([{ t: 'p', text: 'ok' }]);
  });

  it('pre preserva quebras; blockquote vira quote; hr vira hr', () => {
    const blocks = blocksOf('<body><pre>a\n  b\n</pre><blockquote>Citação <i>longa</i></blockquote><hr/></body>');
    expect(blocks[0]).toEqual({ t: 'pre', text: 'a\n  b' });
    expect(blocks[1]).toMatchObject({ t: 'quote', text: 'Citação longa' });
    expect(blocks[2]).toEqual({ t: 'hr' });
  });

  it('texto solto e div sem <p> viram parágrafos; espaços são colapsados', () => {
    const blocks = blocksOf('<body>solto   aqui<div>dentro\n   da div</div></body>');
    expect(blocks).toEqual([
      { t: 'p', text: 'solto aqui' },
      { t: 'p', text: 'dentro da div' },
    ]);
  });

  it('documento vazio devolve lista vazia', () => {
    expect(blocksOf('<body></body>')).toEqual([]);
    expect(blocksOf('<body>   \n  </body>')).toEqual([]);
  });

  it('XHTML estrito (application/xhtml+xml) também funciona', () => {
    const blocks = blocksOf(xhtmlDoc('<h2>Cap</h2><p>Texto <b>forte</b></p>'), 'application/xhtml+xml');
    expect(blocks[0]).toEqual({ t: 'h', level: 2, text: 'Cap' });
    expect(blocks[1]).toMatchObject({ t: 'p', text: 'Texto forte' });
  });

  it('li solto e dl/dt/dd não quebram', () => {
    const blocks = blocksOf('<body><li>solto</li><dl><dt>Termo</dt><dd>Definição</dd></dl></body>');
    expect(blocks.map((b) => ('text' in b ? b.text : ''))).toEqual(['solto', 'Termo', 'Definição']);
  });

  it('item de lista com parágrafos e imagem dentro', () => {
    const blocks = blocksOf('<body><ul><li><p>um</p><p>dois</p><img src="a.png"/></li></ul></body>');
    expect(blocks[0]).toMatchObject({ t: 'li', text: 'um\ndois' });
    expect(blocks[1]).toMatchObject({ t: 'img', src: 'img:a.png' });
  });
});

describe('parseEpub com DOMParser real', () => {
  const ch = (n: number, title = `Capítulo ${n}`) => ({
    file: `Text/ch${n}.xhtml`,
    xhtml: xhtmlDoc(`<h1>${title}</h1><p>Conteúdo do capítulo ${n} com acentuação: ação, coração.</p>`),
  });

  it('EPUB 3: títulos do sumário vêm de nav.xhtml; metadados e idioma', async () => {
    const epub = buildEpub({
      version: 3,
      title: 'Meu Livro',
      author: 'Ana Souza',
      chapters: [ch(1), ch(2)],
      toc: [
        { file: 'Text/ch1.xhtml', title: 'Primeiro (do nav)' },
        { file: 'Text/ch2.xhtml', title: 'Segundo (do nav)' },
      ],
    });
    const book = await parse(epub);
    expect(book.title).toBe('Meu Livro');
    expect(book.author).toBe('Ana Souza');
    expect(book.lang).toBe('pt-BR');
    expect(book.chapters.map((c) => c.title)).toEqual(['Primeiro (do nav)', 'Segundo (do nav)']);
    expect(book.chapters[0].blocks[0]).toEqual({ t: 'h', level: 1, text: 'Capítulo 1' });
  });

  it('EPUB 2: títulos vêm de toc.ncx', async () => {
    const epub = buildEpub({
      version: 2,
      chapters: [ch(1), ch(2)],
      toc: [
        { file: 'Text/ch1.xhtml', title: 'Um (ncx)' },
        { file: 'Text/ch2.xhtml', title: 'Dois (ncx)' },
      ],
    });
    const book = await parse(epub);
    expect(book.chapters.map((c) => c.title)).toEqual(['Um (ncx)', 'Dois (ncx)']);
  });

  it('sem sumário, usa o primeiro título do capítulo; sem título, "Capítulo N"', async () => {
    const epub = buildEpub({
      chapters: [
        ch(1, 'Do Cabeçalho'),
        { file: 'Text/ch2.xhtml', xhtml: xhtmlDoc('<p>sem título aqui</p>') },
      ],
    });
    const book = await parse(epub);
    expect(book.chapters.map((c) => c.title)).toEqual(['Do Cabeçalho', 'Capítulo 2']);
  });

  it('capa por <meta name="cover"> (EPUB 2)', async () => {
    const book = await parse(buildEpub({ version: 2, cover: 'meta', chapters: [ch(1)] }));
    expect(book.cover).toBeInstanceOf(Blob);
    expect(book.cover?.type).toBe('image/png');
  });

  it('capa por properties="cover-image" (EPUB 3)', async () => {
    const book = await parse(buildEpub({ version: 3, cover: 'properties', chapters: [ch(1)] }));
    expect(book.cover?.type).toBe('image/png');
    expect(book.cover?.size).toBeGreaterThan(0);
  });

  it('sem capa declarada, usa a primeira imagem do primeiro capítulo', async () => {
    const epub = buildEpub({
      chapters: [{ file: 'Text/a.xhtml', xhtml: xhtmlDoc('<p>x</p><img src="../Images/f.png" alt="f"/>') }],
      extra: { 'Images/f.png': png() },
    });
    const book = await parse(epub);
    expect(book.cover).toBeDefined();
  });

  it('imagens relativas (../Images/x.png) viram chaves em images e blocos img', async () => {
    const epub = buildEpub({
      chapters: [
        { file: 'Text/a.xhtml', xhtml: xhtmlDoc('<p>fig</p><img src="../Images/x.png" alt="X"/><img src="../Images/x.png"/><img src="../Images/falta.png"/>') },
      ],
      extra: { 'Images/x.png': png() },
    });
    const book = await parse(epub);
    const imgs = book.chapters[0].blocks.filter((b) => b.t === 'img');
    expect(imgs).toHaveLength(2); // a que não existe no zip é descartada
    expect(book.images.size).toBe(1);
    const key = (imgs[0] as { src: string }).src;
    expect(book.images.get(key)?.type).toBe('image/png');
    expect((imgs[1] as { src: string }).src).toBe(key); // mesma imagem reaproveitada
  });

  it('XHTML malformado cai no parser text/html e ainda extrai o texto', async () => {
    const epub = buildEpub({
      chapters: [{ file: 'Text/a.xhtml', xhtml: '<html><body><h1>Quebrado<p>parágrafo sem fechar <b>negrito<br>quebra &nbsp; fim</body>' }],
    });
    const book = await parse(epub);
    const text = book.chapters[0].blocks.map((b) => ('text' in b ? b.text : '')).join(' ');
    expect(text).toContain('Quebrado');
    expect(text).toContain('parágrafo sem fechar');
  });

  it('entidades HTML nomeadas só funcionam no fallback; XHTML válido com entidades XML funciona', async () => {
    const epub = buildEpub({
      chapters: [{ file: 'Text/a.xhtml', xhtml: xhtmlDoc('<p>Tom &amp; Jerry &lt;3 &#169;</p>') }],
    });
    const book = await parse(epub);
    expect(book.chapters[0].blocks[0]).toMatchObject({ text: 'Tom & Jerry <3 ©' });
  });

  it('item da spine com linear="no" continua importado, na ordem da spine', async () => {
    const epub = buildEpub({
      chapters: [ch(1), { ...ch(2, 'Notas'), linear: false }, ch(3)],
    });
    const book = await parse(epub);
    expect(book.chapters.map((c) => c.title)).toEqual(['Capítulo 1', 'Notas', 'Capítulo 3']);
  });

  it('capítulo sem conteúdo é omitido; item da spine ausente no zip é ignorado', async () => {
    const epub = buildEpub({
      chapters: [ch(1), { file: 'Text/vazio.xhtml', xhtml: xhtmlDoc('') }, ch(3)],
    });
    const book = await parse(epub);
    expect(book.chapters).toHaveLength(2);
  });

  it('OPF em diretório raiz (sem pasta) e título ausente cai no nome do arquivo', async () => {
    const epub = buildEpub({ opfDir: '', title: '', chapters: [{ file: 'a.xhtml', xhtml: xhtmlDoc('<p>oi</p>') }] });
    const book = await parse(epub, 'Meu Arquivo.epub');
    expect(book.title).toBe('Meu Arquivo');
    expect(book.chapters).toHaveLength(1);
  });

  it('reporta progresso crescente até 1', async () => {
    const seen: number[] = [];
    await parseEpub(toBuf(buildEpub({ chapters: [ch(1), ch(2)] })), 'x.epub', (f) => seen.push(f));
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('aceita um parser injetado', async () => {
    const book = await parseEpub(toBuf(buildEpub({ chapters: [ch(1)] })), 'x.epub', noop, {
      parseDocument: (html) => new DOMParser().parseFromString(html, 'text/html'),
    });
    expect(book.chapters).toHaveLength(1);
  });
});

describe('parseEpub: robustez', () => {
  it('sem container.xml: erro legível', async () => {
    const epub = buildEpub({ chapters: [{ file: 'a.xhtml', xhtml: xhtmlDoc('<p>x</p>') }], omitContainer: true });
    await expect(parse(epub)).rejects.toThrow(/container\.xml/);
  });

  it('container.xml sem rootfile: erro legível', async () => {
    const zip = zipSync({ 'META-INF/container.xml': strToU8('<container/>') });
    await expect(parse(zip)).rejects.toThrow(/OPF/);
  });

  it('OPF apontado mas ausente: erro legível', async () => {
    const zip = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="x/content.opf"/></rootfiles></container>'),
    });
    await expect(parse(zip)).rejects.toThrow(/ausente/);
  });

  it('zip corrompido: erro legível em português, sem travar', async () => {
    const good = buildEpub({ chapters: [{ file: 'a.xhtml', xhtml: xhtmlDoc('<p>x</p>') }] });
    const broken = good.slice(0, Math.floor(good.length / 2));
    await expect(parse(broken)).rejects.toThrow(/EPUB/);
    await expect(parse(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/EPUB/);
    await expect(parse(new Uint8Array(0))).rejects.toThrow(/EPUB/);
  });
});

describe('parseEpub: correções de codificação, fallback HTML, caminhos, SVG e pre-paginated', () => {
  const CONTAINER =
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

  function encodeUtf16LeWithBom(text: string): Uint8Array {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      out[2 + i * 2] = code & 0xff;
      out[2 + i * 2 + 1] = code >> 8;
    }
    return out;
  }

  it('ignora entradas não usadas (fontes, CSS, JS, áudio, vídeo) sem quebrar a importação (achado 1)', async () => {
    const epub = buildEpub({
      chapters: [{ file: 'Text/c1.xhtml', xhtml: xhtmlDoc('<p>Texto normal</p><img src="../Styles/app.css"/>') }],
      extra: {
        'Styles/app.css': strToU8('body { color: red; }'),
        'Fonts/serif.ttf': new Uint8Array([0, 1, 2, 3]),
        'Audio/narra.mp3': new Uint8Array([4, 5, 6, 7]),
        'Video/clip.mp4': new Uint8Array([8, 9, 10, 11]),
        'Scripts/x.js': strToU8('alert(1)'),
      },
    });
    const book = await parse(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.images.size).toBe(0);
  });

  it('importa EPUB em UTF-16LE com BOM e EPUB 2 em ISO-8859-1 preservando acentos (achado 2)', async () => {
    const opfUtf16 =
      '<?xml version="1.0" encoding="utf-16"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Ação em UTF-16</dc:title></metadata>' +
      '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>';
    const chUtf16 = xhtmlDoc('<h1>Coração</h1><p>Texto acentuado: é, ç, ã.</p>');
    const zipUtf16 = zipSync({
      'META-INF/container.xml': encodeUtf16LeWithBom(CONTAINER),
      'OEBPS/content.opf': encodeUtf16LeWithBom(opfUtf16),
      'OEBPS/c1.xhtml': encodeUtf16LeWithBom(chUtf16),
    });
    const book16 = await parse(zipUtf16);
    expect(book16.title).toBe('Ação em UTF-16');
    expect(book16.chapters[0].blocks[0]).toEqual({ t: 'h', level: 1, text: 'Coração' });

    const latin = (s: string): Uint8Array => {
      const map: Record<string, number> = { ç: 0xe7, ã: 0xe3, é: 0xe9, '—': 0x97 };
      return new Uint8Array(Array.from(s, (ch) => map[ch] ?? ch.charCodeAt(0)));
    };
    const opfLatin =
      '<?xml version="1.0" encoding="iso-8859-1"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Coração</dc:title></metadata>' +
      '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>';
    const chLatin =
      '<?xml version="1.0" encoding="iso-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ação — café</p></body></html>';
    const zipLatin = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': latin(opfLatin),
      'OEBPS/c1.xhtml': latin(chLatin),
    });
    const bookLatin = await parse(zipLatin);
    expect(bookLatin.title).toBe('Coração');
    expect(bookLatin.chapters[0].blocks[0]).toEqual({ t: 'p', text: 'Ação — café' });
  });

  it('fallback text/html não descarta o capítulo quando há <title/>, <style/> ou <script/> autofechados (achado 3)', async () => {
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title/><style/><script src="x.js"/></head>' +
      '<body><h1>Capítulo preservado</h1><p>Texto com &nbsp; e <br> quebra</p></body></html>';
    const epub = buildEpub({ chapters: [{ file: 'Text/c1.xhtml', xhtml }] });
    const book = await parse(epub);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('Capítulo preservado');
    expect(book.chapters[0].blocks[1]).toMatchObject({ t: 'p', text: expect.stringContaining('Texto com') });
  });

  it('item de spine SVG extrai a imagem raster referenciada sem descartar a página (achado 4)', async () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>HQ SVG</dc:title></metadata>
        <manifest>
          <item id="p1" href="Images/p1.svg" media-type="image/svg+xml"/>
          <item id="img1" href="Images/p1.png" media-type="image/png"/>
        </manifest>
        <spine><itemref idref="p1"/></spine>
      </package>`;
    const svgPage =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900">' +
      '<image width="100%" height="100%" xlink:href="p1.png"/></svg>';
    const zip = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/Images/p1.svg': strToU8(svgPage),
      'OEBPS/Images/p1.png': png(),
    });
    const book = await parse(zip);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].blocks).toHaveLength(1);
    expect(book.chapters[0].blocks[0]).toMatchObject({ t: 'img' });
    expect(book.images.size).toBe(1);
  });

  it('sumário e imagens funcionam com caixa diferente e diretórios com # ou % (achado 8)', async () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Caminhos</dc:title></metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="Ch%232/ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="img" href="Images/fig%201.png" media-type="image/png"/>
        </manifest>
        <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
      </package>`;
    const nav = xhtmlDoc(
      '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Capítulo Case-Insensitive</a></li></ol></nav>',
    );
    const zip = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/nav.xhtml': strToU8(nav),
      'OEBPS/Text/ch1.xhtml': strToU8(xhtmlDoc('<p>Um</p><img src="../images/fig%201.png"/>')),
      'OEBPS/Ch#2/ch2.xhtml': strToU8(xhtmlDoc('<p>Dois</p><img src="../Images/fig%201.png"/>')),
      'OEBPS/Images/fig 1.png': png(),
    });
    const book = await parse(zip);
    expect(book.chapters[0].title).toBe('Capítulo Case-Insensitive');
    expect(book.images.size).toBe(1); // mesma imagem sem duplicar
    const imgs1 = book.chapters[0].blocks.filter((b) => b.t === 'img');
    const imgs2 = book.chapters[1].blocks.filter((b) => b.t === 'img');
    expect(imgs1).toHaveLength(1);
    expect(imgs2).toHaveLength(1);
    if (imgs1[0].t === 'img' && imgs2[0].t === 'img') {
      expect(imgs1[0].src).toBe(imgs2[0].src);
    }
  });

  it('rejeita HTML/XHTML disfarçado de imagem, descarta SVG sem canvas com aviso e rasteriza SVG quando disponível (achado 12 e segurança)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><script>alert(1)</script><rect width="50" height="50" fill="red"/></svg>';
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Imagens</dc:title></metadata>
        <manifest>
          <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
          <item id="falso" href="Images/falso.png" media-type="image/png"/>
          <item id="vec" href="Images/desenho.svg" media-type="image/svg+xml"/>
          <item id="capa" href="Images/capa.svg" media-type="image/svg+xml" properties="cover-image"/>
        </manifest>
        <spine><itemref idref="c1"/></spine>
      </package>`;
    const zip = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/Text/c1.xhtml': strToU8(
        xhtmlDoc('<p>Texto</p><img src="../Images/falso.png"/><img src="../Images/desenho.svg"/><img src="c1.xhtml"/>'),
      ),
      'OEBPS/Images/falso.png': strToU8('<html><body>não é PNG</body></html>'),
      'OEBPS/Images/desenho.svg': strToU8(svg),
      'OEBPS/Images/capa.svg': strToU8(svg),
    });

    // Sem canvas (happy-dom): SVG é descartado e registrado em warnings; HTML falso é rejeitado
    const semCanvas = await parse(zip);
    expect(semCanvas.images.size).toBe(0);
    expect(semCanvas.cover).toBeUndefined();
    expect(semCanvas.chapters[0].blocks).toEqual([{ t: 'p', text: 'Texto' }]);
    expect(semCanvas.warnings?.some((w) => /SVG/i.test(w))).toBe(true);

    // Com rasterizador disponível: SVGs viram PNG (nunca image/svg+xml)
    const pngFake = new Blob([png().slice()], { type: 'image/png' });
    const comCanvas = await parseEpub(toBuf(zip), 'livro.epub', noop, {
      rasterizeSvg: async () => pngFake,
    });
    expect(comCanvas.cover?.type).toBe('image/png');
    expect(comCanvas.images.size).toBe(1);
    for (const blob of comCanvas.images.values()) {
      expect(blob.type).toBe('image/png');
    }
    expect(comCanvas.warnings).toBeUndefined();
  });

  it('emite aviso em warnings para EPUB pre-paginated com texto sem alterar fixedLayout (achado 12)', async () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Layout Fixo</dc:title>
          <meta property="rendition:layout">pre-paginated</meta>
        </metadata>
        <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="c1"/></spine>
      </package>`;
    const zipTexto = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/c1.xhtml': strToU8(xhtmlDoc('<p>Texto posicionado</p>')),
    });
    const bookTexto = await parse(zipTexto);
    expect(bookTexto.fixedLayout).toBeUndefined();
    expect(bookTexto.warnings?.some((w) => /pre-paginated|layout fixo/i.test(w))).toBe(true);

    const zipSoImagem = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/c1.xhtml': strToU8(xhtmlDoc('<img src="p1.png"/>')),
      'OEBPS/p1.png': png(),
    });
    const bookSoImagem = await parse(zipSoImagem);
    expect(bookSoImagem.fixedLayout).toBeUndefined();
    expect(bookSoImagem.warnings).toBeUndefined();
  });
});
