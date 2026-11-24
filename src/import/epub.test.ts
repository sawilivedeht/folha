import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
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
      'OEBPS/Images/cover.png': new Uint8Array([137, 80, 78, 71]),
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
