// Gerador de EPUBs de teste em memória (fflate). Não versiona binários.
import { strToU8, zipSync } from 'fflate';
import { solidPng } from './pdf-fixtures';

export interface EpubChapter {
  file: string; // caminho relativo ao diretório do OPF
  xhtml: string; // conteúdo completo do arquivo
  id?: string;
  linear?: boolean;
}

export interface EpubSpec {
  version?: 2 | 3;
  title?: string;
  author?: string;
  lang?: string;
  opfDir?: string; // ex.: 'OEBPS'
  chapters: EpubChapter[];
  /** Entradas do sumário: arquivo → título. */
  toc?: Array<{ file: string; title: string }>;
  /** Capa: 'meta' (EPUB 2, <meta name="cover">) ou 'properties' (EPUB 3, cover-image). */
  cover?: 'meta' | 'properties';
  /** Arquivos extras (relativos ao OPF). */
  extra?: Record<string, Uint8Array>;
  omitContainer?: boolean;
}

export const png = (r = 200, g = 30, b = 30) => solidPng(4, 4, [r, g, b]);

export function xhtmlDoc(body: string, head = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

export function buildEpub(spec: EpubSpec): Uint8Array {
  const dir = spec.opfDir ?? 'OEBPS';
  const pre = dir ? `${dir}/` : '';
  const version = spec.version ?? 3;
  const files: Record<string, Uint8Array> = {};
  files.mimetype = strToU8('application/epub+zip');
  if (!spec.omitContainer) {
    files['META-INF/container.xml'] = strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${pre}content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    );
  }

  const manifest: string[] = [];
  const spine: string[] = [];
  spec.chapters.forEach((c, i) => {
    const id = c.id ?? `c${i + 1}`;
    files[`${pre}${c.file}`] = strToU8(c.xhtml);
    manifest.push(`<item id="${id}" href="${c.file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"${c.linear === false ? ' linear="no"' : ''}/>`);
  });

  const toc = spec.toc ?? [];
  if (version === 3) {
    const lis = toc.map((t) => `<li><a href="${t.file}">${t.title}</a></li>`).join('');
    files[`${pre}nav.xhtml`] = strToU8(
      xhtmlDoc(`<nav epub:type="toc"><ol>${lis}</ol></nav>`),
    );
    manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  } else {
    const points = toc
      .map((t, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${t.title}</text></navLabel><content src="${t.file}"/></navPoint>`)
      .join('');
    files[`${pre}toc.ncx`] = strToU8(
      `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`,
    );
    manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  }

  let coverMeta = '';
  if (spec.cover) {
    files[`${pre}Images/capa.png`] = png(10, 120, 200);
    manifest.push(
      `<item id="capa" href="Images/capa.png" media-type="image/png"${spec.cover === 'properties' ? ' properties="cover-image"' : ''}/>`,
    );
    if (spec.cover === 'meta') coverMeta = '<meta name="cover" content="capa"/>';
  }
  for (const [path, bytes] of Object.entries(spec.extra ?? {})) {
    files[`${pre}${path}`] = bytes;
    const ext = path.split('.').pop() ?? '';
    const mt = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'application/octet-stream';
    manifest.push(`<item id="x${manifest.length}" href="${path}" media-type="${mt}"/>`);
  }

  files[`${pre}content.opf`] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:teste</dc:identifier>
<dc:title>${spec.title ?? 'Livro de Teste'}</dc:title>
<dc:creator>${spec.author ?? 'Autora Teste'}</dc:creator>
<dc:language>${spec.lang ?? 'pt-BR'}</dc:language>
${coverMeta}
</metadata>
<manifest>${manifest.join('')}</manifest>
<spine${version === 2 ? ' toc="ncx"' : ''}>${spine.join('')}</spine>
</package>`,
  );

  // mimetype primeiro e sem compressão, como manda a especificação.
  return zipSync({ mimetype: [files.mimetype, { level: 0 }], ...Object.fromEntries(Object.entries(files).filter(([k]) => k !== 'mimetype')) });
}
