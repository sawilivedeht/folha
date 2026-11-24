// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Block } from '../types';
import { htmlToBlocks } from './html-blocks';

function blocksOf(html: string, type: DOMParserSupportedType = 'text/html'): Block[] {
  const doc = new DOMParser().parseFromString(html, type);
  return htmlToBlocks(doc, { resolveImage: (src) => `img:${src}` });
}

describe('htmlToBlocks: tabelas, citações, títulos, listas e SVG (achado 4)', () => {
  it('preserva <caption> e imagens dentro de células de tabela', () => {
    const blocks = blocksOf(
      '<body><table><caption>Tabela 1 — Resumo</caption><tr><td><img src="fig.png" alt="Figura"/></td><td>Descrição</td></tr></table></body>',
    );
    expect(blocks[0]).toEqual({ t: 'p', text: 'Tabela 1 — Resumo' });
    expect(blocks[1]).toEqual({ t: 'p', text: 'Descrição' });
    expect(blocks[2]).toEqual({ t: 'img', src: 'img:fig.png', alt: 'Figura' });
  });

  it('separa células e linhas de tabela aninhada sem colar palavras', () => {
    const blocks = blocksOf(
      '<body><table><tr><td>fora<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table></td></tr></table></body>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].t).toBe('p');
    if (blocks[0].t === 'p') {
      expect(blocks[0].text).not.toContain('AB');
      expect(blocks[0].text).not.toContain('CD');
      expect(blocks[0].text).toContain('A B');
      expect(blocks[0].text).toContain('C D');
    }
  });

  it('preserva imagem em heading e usa alt como fallback textual quando não há texto', () => {
    const blocks = blocksOf('<body><h1><img src="banner.png" alt="Capítulo I"/></h1></body>');
    expect(blocks).toEqual([
      { t: 'h', level: 1, text: 'Capítulo I' },
      { t: 'img', src: 'img:banner.png', alt: 'Capítulo I' },
    ]);
  });

  it('heading com texto real e imagem preserva ambos sem duplicar alt', () => {
    const blocks = blocksOf('<body><h2>Título real <img src="orn.png" alt="ornamento"/></h2></body>');
    expect(blocks).toEqual([
      { t: 'h', level: 2, text: 'Título real' },
      { t: 'img', src: 'img:orn.png', alt: 'ornamento' },
    ]);
  });

  it('heading só com imagem sem alt preserva a imagem sem criar heading vazio', () => {
    const blocks = blocksOf('<body><h1><img src="banner.png"/></h1></body>');
    expect(blocks).toEqual([{ t: 'img', src: 'img:banner.png' }]);
  });

  it('preserva imagens dentro de blockquote', () => {
    const blocks = blocksOf(
      '<body><blockquote><p>Antes da figura</p><img src="c.png" alt="Citação"/><p>Depois</p></blockquote></body>',
    );
    expect(blocks).toEqual([
      { t: 'quote', text: 'Antes da figura' },
      { t: 'img', src: 'img:c.png', alt: 'Citação' },
      { t: 'quote', text: 'Depois' },
    ]);
  });

  it('não descarta texto solto, <p>, <h2> ou <div> envolvendo <li> dentro de listas', () => {
    const blocks = blocksOf(
      '<body><ol><h2>Passos</h2><p>Nota inicial</p><div><li>Primeiro</li><li>Segundo</li></div>texto solto</ol></body>',
    );
    expect(blocks).toEqual([
      { t: 'h', level: 2, text: 'Passos' },
      { t: 'p', text: 'Nota inicial' },
      { t: 'li', text: 'Primeiro', ordered: true },
      { t: 'li', text: 'Segundo', ordered: true },
      { t: 'p', text: 'texto solto' },
    ]);
  });

  it('extrai imagem quando a raiz do documento é <svg> (item de spine SVG)', () => {
    const svgXml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900">' +
      '<image width="600" height="900" xlink:href="capa.jpg"/></svg>';
    const blocks = blocksOf(svgXml, 'application/xhtml+xml');
    expect(blocks).toEqual([{ t: 'img', src: 'img:capa.jpg', w: 600, h: 900 }]);
  });
});

describe('htmlToBlocks: dimensões relativas e <svg:image> prefixado (achado 9)', () => {
  it('rejeita dimensões percentuais ou em unidades relativas e aceita inteiros ou px', () => {
    const blocks = blocksOf(
      '<body>' +
        '<svg viewBox="0 0 600 900"><image width="100%" height="100%" href="capa.jpg"/></svg>' +
        '<img src="a.png" width="50em" height="auto"/>' +
        '<img src="b.png" width="320px" height="240.5px"/>' +
        '</body>',
    );
    expect(blocks[0]).toEqual({ t: 'img', src: 'img:capa.jpg' });
    expect(blocks[1]).toEqual({ t: 'img', src: 'img:a.png' });
    expect(blocks[2]).toEqual({ t: 'img', src: 'img:b.png', w: 320, h: 240 });
  });

  it('extrai <svg:image> com prefixo de namespace em XHTML', () => {
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<body><svg:svg viewBox="0 0 400 600"><svg:image width="100%" height="100%" xlink:href="capa.jpeg"/></svg:svg></body></html>';
    const blocks = blocksOf(xhtml, 'application/xhtml+xml');
    expect(blocks).toEqual([{ t: 'img', src: 'img:capa.jpeg' }]);
  });
});

describe('htmlToBlocks: blocos dentro de inline e <li> (achado 10)', () => {
  it('não cola palavras quando há blocos dentro de elementos inline como <a>', () => {
    const blocks = blocksOf('<body><a><div>Capítulo 1</div><div>O começo</div></a></body>');
    expect(blocks).toEqual([{ t: 'p', text: 'Capítulo 1\nO começo' }]);
  });

  it('não cola palavras em <li><div><p>...</p><p>...</p></div></li>', () => {
    const blocks = blocksOf('<body><ul><li><div><p>Um</p><p>Dois</p></div></li></ul></body>');
    expect(blocks).toEqual([{ t: 'li', text: 'Um\nDois', ordered: false }]);
  });

  it('preserva quebras e indentação de <pre> dentro de <li>', () => {
    const blocks = blocksOf('<body><ul><li><p>Exemplo:</p><pre>linha 1\n  linha 2</pre></li></ul></body>');
    expect(blocks).toEqual([
      { t: 'li', text: 'Exemplo:', ordered: false },
      { t: 'pre', text: 'linha 1\n  linha 2' },
    ]);
  });

  it('delega <blockquote> e <table> dentro de <li> para seus blocos próprios', () => {
    const blocks = blocksOf(
      '<body><ol><li>Item<blockquote>Citação interna</blockquote></li></ol></body>',
    );
    expect(blocks).toEqual([
      { t: 'li', text: 'Item', ordered: true },
      { t: 'quote', text: 'Citação interna' },
    ]);
  });
});
