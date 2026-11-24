import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  decodeXmlBytes,
  detectImageMime,
  isIgnoredZipEntry,
  mimeFromPath,
  normalizeZipPath,
  parseContainerXml,
  parseEpub,
  parseNavToc,
  parseNcxToc,
  parseOpf,
  resolveRelativePath,
} from './epub';

describe('epub path & mime helpers', () => {
  it('normalizes zip paths, dot segments, hashes and URI encoding', () => {
    expect(normalizeZipPath('/OEBPS/Text/../Images/capa%201.jpg#top')).toBe('OEBPS/Images/capa 1.jpg');
    expect(normalizeZipPath('OPS\\ch1.xhtml?x=1')).toBe('OPS/ch1.xhtml');
  });

  it('resolves relative hrefs against base file path', () => {
    expect(resolveRelativePath('OEBPS/Text/ch1.xhtml', '../Images/fig1.png')).toBe('OEBPS/Images/fig1.png');
    expect(resolveRelativePath('OEBPS/content.opf', 'Text/ch1.xhtml#sec2')).toBe('OEBPS/Text/ch1.xhtml');
    expect(resolveRelativePath('OEBPS/Text/ch1.xhtml', '/cover.jpg')).toBe('cover.jpg');
  });

  it('infers MIME types from extensions', () => {
    expect(mimeFromPath('images/cover.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('images/fig.PNG')).toBe('image/png');
    expect(mimeFromPath('images/vector.svg')).toBe('image/svg+xml');
    expect(mimeFromPath('unknown.bin')).toBe('application/octet-stream');
  });
});

describe('parseContainerXml', () => {
  it('extracts rootfile full-path', () => {
    const xml = `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`;
    expect(parseContainerXml(xml)).toBe('OEBPS/content.opf');
  });

  it('returns null when rootfile is missing', () => {
    expect(parseContainerXml('<container/>')).toBeNull();
  });
});

describe('parseOpf', () => {
  it('extracts metadata, manifest, spine and cover id', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Dom Casmurro &amp; Outros</dc:title>
          <dc:creator>Machado de Assis</dc:creator>
          <dc:language>pt-BR</dc:language>
          <meta name="cover" content="cover-img"/>
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="cover-img" href="Images/capa.jpg" media-type="image/jpeg" properties="cover-image"/>
          <item id="ch1" href="Text/cap1.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch2" href="Text/cap2.xhtml" media-type="application/xhtml+xml"/>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        </manifest>
        <spine toc="ncx">
          <itemref idref="ch1"/>
          <itemref idref="ch2" linear="no"/>
        </spine>
      </package>`;

    const parsed = parseOpf(opf, 'OEBPS/content.opf');
    expect(parsed.title).toBe('Dom Casmurro & Outros');
    expect(parsed.author).toBe('Machado de Assis');
    expect(parsed.lang).toBe('pt-BR');
    expect(parsed.coverId).toBe('cover-img');
    expect(parsed.tocId).toBe('ncx');
    expect(parsed.manifest.get('ch1')?.href).toBe('OEBPS/Text/cap1.xhtml');
    expect(parsed.manifest.get('cover-img')?.properties).toEqual(['cover-image']);
    expect(parsed.spine).toEqual([
      { idref: 'ch1', linear: true },
      { idref: 'ch2', linear: false },
    ]);
  });
});

describe('TOC parsers (NCX and NAV)', () => {
  it('parses EPUB 2 toc.ncx including nested navPoints', () => {
    const ncx = `<?xml version="1.0"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <navMap>
          <navPoint id="p1" playOrder="1">
            <navLabel><text>Parte I</text></navLabel>
            <content src="Text/ch1.xhtml#start"/>
            <navPoint id="p2" playOrder="2">
              <navLabel><text>Capítulo 1</text></navLabel>
              <content src="Text/ch2.xhtml"/>
            </navPoint>
          </navPoint>
        </navMap>
      </ncx>`;
    const toc = parseNcxToc(ncx, 'OEBPS/toc.ncx');
    expect(toc.get('OEBPS/Text/ch1.xhtml')).toBe('Parte I');
    expect(toc.get('OEBPS/Text/ch2.xhtml')).toBe('Capítulo 1');
  });

  it('parses EPUB 3 nav.xhtml prioritizing epub:type="toc"', () => {
    const nav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <body>
        <nav epub:type="landmarks"><ol><li><a href="Text/ch1.xhtml">Início</a></li></ol></nav>
        <nav epub:type="toc">
          <ol>
            <li><a href="Text/ch1.xhtml#top"><span>Capítulo Um</span></a></li>
            <li><a href="Text/ch2.xhtml">Capítulo Dois</a></li>
          </ol>
        </nav>
      </body>
    </html>`;
    const toc = parseNavToc(nav, 'OEBPS/nav.xhtml');
    expect(toc.get('OEBPS/Text/ch1.xhtml')).toBe('Capítulo Um');
    expect(toc.get('OEBPS/Text/ch2.xhtml')).toBe('Capítulo Dois');
  });
});

describe('parseEpub (with injected document parser)', () => {
  it('throws clear error when container.xml is missing', async () => {
    const zipped = zipSync({ 'readme.txt': strToU8('not an epub') });
    await expect(parseEpub(zipped.slice().buffer, 'bad.epub', () => {})).rejects.toThrow(/container\.xml/);
  });

  it('imports metadata, cover, chapters and progress from a minimal EPUB zip', async () => {
    const containerXml = `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
      </container>`;
    const opfXml = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Livro Teste</dc:title>
          <dc:creator>Autor Teste</dc:creator>
          <dc:language>pt</dc:language>
          <meta name="cover" content="cov"/>
        </metadata>
        <manifest>
          <item id="cov" href="Images/cover.png" media-type="image/png"/>
          <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="ch1"/></spine>
      </package>`;

    const zipped = zipSync({
      'META-INF/container.xml': strToU8(containerXml),
      'OEBPS/content.opf': strToU8(opfXml),
      'OEBPS/Images/cover.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'OEBPS/Text/ch1.xhtml': strToU8('<html><body><h1>Abertura</h1><p>Olá mundo.</p></body></html>'),
    });

    const mockDoc = {
      body: {
        nodeType: 1,
        localName: 'body',
        tagName: 'BODY',
        childNodes: [
          {
            nodeType: 1,
            localName: 'h1',
            tagName: 'H1',
            childNodes: [{ nodeType: 3, textContent: 'Abertura' }],
          },
          {
            nodeType: 1,
            localName: 'p',
            tagName: 'P',
            childNodes: [{ nodeType: 3, textContent: 'Olá mundo.' }],
          },
        ],
      },
    } as unknown as Document;

    const progressCalls: number[] = [];
    const book = await parseEpub(
      zipped.slice().buffer,
      'teste.epub',
      (f) => progressCalls.push(f),
      { parseDocument: () => mockDoc },
    );

    expect(book.title).toBe('Livro Teste');
    expect(book.author).toBe('Autor Teste');
    expect(book.lang).toBe('pt');
    expect(book.cover).toBeInstanceOf(Blob);
    expect(book.cover?.type).toBe('image/png');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('Abertura');
    expect(book.chapters[0].blocks).toEqual([
      { t: 'h', level: 1, text: 'Abertura' },
      { t: 'p', text: 'Olá mundo.' },
    ]);
    expect(progressCalls[progressCalls.length - 1]).toBe(1);
  });
});

describe('filtro de entradas do ZIP (achado 1)', () => {
  it('ignora fontes, áudio, vídeo, CSS, JS e diretórios na descompactação', () => {
    for (const ignored of [
      'OEBPS/Fonts/serif.ttf',
      'OEBPS/Fonts/sans.OTF',
      'OEBPS/Fonts/book.woff2',
      'OEBPS/Audio/ch1.mp3',
      'OEBPS/Video/clip.mp4',
      'OEBPS/Styles/main.css',
      'OEBPS/Scripts/app.js',
      'OEBPS/Images/',
    ]) {
      expect(isIgnoredZipEntry(ignored), ignored).toBe(true);
    }
    for (const kept of [
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/toc.ncx',
      'OEBPS/Text/ch1.xhtml',
      'OEBPS/Text/ch2.html',
      'OEBPS/Images/capa.png',
      'OEBPS/Images/fig.jpg',
      'OEBPS/Images/vetor.svg',
      'mimetype',
    ]) {
      expect(isIgnoredZipEntry(kept), kept).toBe(false);
    }
  });
});

describe('decodeXmlBytes: UTF-16 e ISO-8859-1/windows-1252 (achado 2)', () => {
  function toUtf16(text: string, le: boolean, bom: boolean): Uint8Array {
    const out: number[] = bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      out.push(...(le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
    }
    return new Uint8Array(out);
  }

  it('decodifica UTF-16LE e UTF-16BE com e sem BOM', () => {
    const xml = '<?xml version="1.0"?><p>Coração</p>';
    expect(decodeXmlBytes(toUtf16(xml, true, true))).toBe(xml);
    expect(decodeXmlBytes(toUtf16(xml, false, true))).toBe(xml);
    expect(decodeXmlBytes(toUtf16(xml, true, false))).toBe(xml);
    expect(decodeXmlBytes(toUtf16(xml, false, false))).toBe(xml);
  });

  it('respeita encoding="iso-8859-1" no prólogo XML e <meta charset="windows-1252">', () => {
    // "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><p>coração — pé</p>" em windows-1252
    const prefix = '<?xml version="1.0" encoding="iso-8859-1"?><p>cora';
    const bytes = new Uint8Array([
      ...Array.from(prefix, (c) => c.charCodeAt(0)),
      0xe7, 0xe3, 0x6f, 0x20, 0x97, 0x20, 0x70, 0xe9,
      ...Array.from('</p>', (c) => c.charCodeAt(0)),
    ]);
    expect(decodeXmlBytes(bytes)).toBe('<?xml version="1.0" encoding="iso-8859-1"?><p>coração — pé</p>');

    const htmlPrefix = '<html><head><meta charset="windows-1252"></head><body>a';
    const htmlBytes = new Uint8Array([
      ...Array.from(htmlPrefix, (c) => c.charCodeAt(0)),
      0xe7, 0xe3, 0x6f,
      ...Array.from('</body></html>', (c) => c.charCodeAt(0)),
    ]);
    expect(decodeXmlBytes(htmlBytes)).toContain('ação');
  });
});

describe('parsing XML robusto: CDATA, comentários, autofechadas, entidades e ReDoS (achados 6, 7, 8, 12 e segurança)', () => {
  it('preserva CDATA, ignora comentários XML e pula <dc:title/> autofechado no OPF', () => {
    const opf = `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <!-- <meta name="cover" content="capa-antiga"/> -->
          <dc:title/>
          <dc:creator>Machado de Assis</dc:creator>
          <dc:title><![CDATA[Dom Casmurro & <Outros>]]></dc:title>
          <meta name="cover" content="capa-real"/>
          <meta property="rendition:layout">pre-paginated</meta>
        </metadata>
        <manifest>
          <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine>
          <!-- <itemref idref="fantasma"/> -->
          <itemref idref="ch1"/>
        </spine>
      </package>`;
    const parsed = parseOpf(opf, 'OEBPS/content.opf');
    expect(parsed.title).toBe('Dom Casmurro & <Outros>');
    expect(parsed.author).toBe('Machado de Assis');
    expect(parsed.coverId).toBe('capa-real');
    expect(parsed.prePaginated).toBe(true);
    expect(parsed.spine).toEqual([{ idref: 'ch1', linear: true }]);
  });

  it('detecta pre-paginated também em itemref properties', () => {
    const opf = `<package><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1" properties="page-spread-left rendition:layout-pre-paginated"/></spine></package>`;
    expect(parseOpf(opf, 'content.opf').prePaginated).toBe(true);
  });

  it('preserva CDATA em toc.ncx e aceita prefixo + entidades HTML nomeadas em nav.xhtml', () => {
    const ncx = `<ncx><navMap><navPoint id="n1"><navLabel><text><![CDATA[Cap. 1]]></text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>`;
    expect(parseNcxToc(ncx, 'OEBPS/toc.ncx').get('OEBPS/ch1.xhtml')).toBe('Cap. 1');

    const nav = `<xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <xhtml:body>
        <xhtml:nav epub:type="toc"><xhtml:ol>
          <xhtml:li><xhtml:a href="ch1.xhtml">Cap&iacute;tulo&nbsp;1 &mdash; Pr&oacute;logo &amp; A&ccedil;&atilde;o</xhtml:a></xhtml:li>
        </xhtml:ol></xhtml:nav>
      </xhtml:body></xhtml:html>`;
    expect(parseNavToc(nav, 'OEBPS/nav.xhtml').get('OEBPS/ch1.xhtml')).toBe('Capítulo 1 — Prólogo & Ação');
  });

  it('não lança RangeError com entidades numéricas fora da faixa Unicode (achado 7)', () => {
    const opf = `<package><metadata><dc:title>Teste &#99999999; &#x110000; &#xD800; fim</dc:title></metadata><manifest/><spine/></package>`;
    const parsed = parseOpf(opf, 'content.opf');
    expect(parsed.title).toBe('Teste &#99999999; &#x110000; &#xD800; fim');
  });

  it('resolveRelativePath não trunca # nem falha com % literal no diretório base (achado 8)', () => {
    const chHash = resolveRelativePath('OEBPS/content.opf', 'Ch%231/ch1.xhtml');
    expect(chHash).toBe('OEBPS/Ch#1/ch1.xhtml');
    expect(resolveRelativePath(chHash, 'img%201.png')).toBe('OEBPS/Ch#1/img 1.png');

    const chPct = resolveRelativePath('OEBPS/content.opf', '100%25/ch1.xhtml');
    expect(chPct).toBe('OEBPS/100%/ch1.xhtml');
    expect(resolveRelativePath(chPct, '../Images/fig%201.png#top')).toBe('OEBPS/Images/fig 1.png');
  });

  it('16 mil aberturas sem fechamento em OPF e nav.xhtml rodam em tempo linear (< 200 ms)', () => {
    const opfHostil = `<package><metadata>${'<dc:title>x'.repeat(16_000)}</metadata><manifest/><spine/></package>`;
    const navHostil = `<html><body>${'<nav epub:type="toc"><a>x'.repeat(16_000)}</body></html>`;

    const t0 = performance.now();
    const parsed = parseOpf(opfHostil, 'content.opf');
    const toc = parseNavToc(navHostil, 'nav.xhtml');
    const duracao = performance.now() - t0;

    expect(parsed.title).toBeUndefined();
    expect(toc.size).toBe(0);
    expect(duracao).toBeLessThan(200);
  });

  it('detectImageMime valida imagens raster pelos bytes iniciais e identifica SVG', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageMime(strToU8('GIF89a\x01\x00'))).toBe('image/gif');
    expect(detectImageMime(strToU8('RIFF\x24\x00\x00\x00WEBP'))).toBe('image/webp');
    expect(detectImageMime(strToU8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(detectImageMime(strToU8('<html><body><script>alert(1)</script></body></html>'))).toBeNull();
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
