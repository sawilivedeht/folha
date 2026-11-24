import { describe, it, expect } from 'vitest';
import {
  extractPdfChapters,
  normalizePdfText,
  type PdfPageInput,
  type PdfTextItem,
} from './pdf-layout';

const PAGE_W = 600;
const PAGE_H = 800;

function makeItem(
  str: string,
  x: number,
  y: number,
  opts: Partial<Omit<PdfTextItem, 'str' | 'x' | 'y'>> = {},
): PdfTextItem {
  const h = opts.h ?? 12;
  const w = opts.w ?? Math.max(4, str.length * h * 0.52);
  return {
    str,
    x,
    y,
    w,
    h,
    fontName: opts.fontName ?? 'Times-Roman',
    ...(opts.bold !== undefined ? { bold: opts.bold } : {}),
    ...(opts.italic !== undefined ? { italic: opts.italic } : {}),
  };
}

function makePage(pageNumber: number, items: PdfTextItem[], width = PAGE_W, height = PAGE_H): PdfPageInput {
  return { pageNumber, width, height, items };
}

describe('normalizePdfText', () => {
  it('normaliza ligaduras, espaços especiais e caracteres de controle', () => {
    const raw = 'e\uFB00eito \uFB01nal \uFB02uxo o\uFB03ce a\uFB04uent\u00A0teste\u0007\u200B\ttexto';
    expect(normalizePdfText(raw)).toBe('effeito final fluxo office affluent teste texto');
  });
});

describe('extractPdfChapters - linhas e parágrafos', () => {
  it('agrupa itens na mesma linha inserindo espaços e junta linhas em parágrafos', () => {
    const page = makePage(1, [
      // Linha 1 (y=700) dividida em fragmentos com lacuna entre palavras
      makeItem('Era', 60, 700, { w: 20 }),
      makeItem('uma', 86, 700.5, { w: 26 }),
      makeItem('vez', 118, 699.5, { w: 22 }),
      makeItem('um leitor muito atento que lia livros todos os dias sem', 146, 700, { w: 390 }),
      // Linha 2 (y=684, espaçamento normal = 16) -> continua mesmo parágrafo
      makeItem('nenhuma pressa no fim da tarde tranquila.', 60, 684, { w: 240 }),
      // Linha 3 (y=650, espaçamento maior = 34) -> novo parágrafo
      makeItem('No dia seguinte, o sol nasceu claro sobre a cidade inteira e', 60, 650, { w: 476 }),
      // Linha 4 (y=634, espaçamento normal = 16) -> continua segundo parágrafo
      makeItem('as ruas logo se encheram de gente.', 60, 634, { w: 220 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].blocks).toEqual([
      {
        t: 'p',
        text: 'Era uma vez um leitor muito atento que lia livros todos os dias sem nenhuma pressa no fim da tarde tranquila.',
      },
      {
        t: 'p',
        text: 'No dia seguinte, o sol nasceu claro sobre a cidade inteira e as ruas logo se encheram de gente.',
      },
    ]);
  });

  it('quebra parágrafo por recuo de primeira linha e por linha anterior curta com pontuação final', () => {
    const page = makePage(1, [
      // Parágrafo 1 com 2 linhas (linha 2 curta terminando em ponto)
      makeItem('Primeira linha completa do parágrafo inicial que vai até a margem direita', 60, 700, { w: 480 }),
      makeItem('e termina cedo aqui.', 60, 684, { w: 120 }),
      // Parágrafo 2 sem espaço extra, mas linha anterior foi curta + terminou com ponto
      makeItem('Segundo parágrafo que começa logo abaixo sem espaço vertical extra mas vai', 60, 668, { w: 480 }),
      makeItem('até o final desta linha para preencher toda a largura disponível da página.', 60, 652, { w: 480 }),
      // Parágrafo 3 iniciado por recuo de primeira linha (+24pt)
      makeItem('Terceiro parágrafo identificado pelo recuo clássico de primeira linha.', 84, 636, { w: 456 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].blocks).toHaveLength(3);
    expect(chapters[0].blocks[0]).toEqual({
      t: 'p',
      text: 'Primeira linha completa do parágrafo inicial que vai até a margem direita e termina cedo aqui.',
    });
    expect(chapters[0].blocks[1]).toEqual({
      t: 'p',
      text: 'Segundo parágrafo que começa logo abaixo sem espaço vertical extra mas vai até o final desta linha para preencher toda a largura disponível da página.',
    });
    expect(chapters[0].blocks[2]).toEqual({
      t: 'p',
      text: 'Terceiro parágrafo identificado pelo recuo clássico de primeira linha.',
    });
  });
});

describe('extractPdfChapters - desifenização', () => {
  it('desifeniza palavras quebradas e mantém hífen em compostos e maiúsculas', () => {
    const page = makePage(1, [
      makeItem('O novo compu-', 60, 700, { w: 480 }),
      makeItem('tador chegou em São-', 60, 684, { w: 480 }),
      makeItem('Paulo trazendo bem-', 60, 668, { w: 480 }),
      makeItem('estar e um guarda-', 60, 652, { w: 480 }),
      makeItem('chuva muito anti-', 60, 636, { w: 480 }),
      makeItem('go na segunda-', 60, 620, { w: 480 }),
      makeItem('feira perto do super-', 60, 604, { w: 480 }),
      makeItem('mercado com anti-', 60, 588, { w: 480 }),
      makeItem('inflamatório.', 60, 572, { w: 120 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].blocks).toHaveLength(1);
    const block = chapters[0].blocks[0];
    expect(block.t).toBe('p');
    if (block.t === 'p') {
      expect(block.text).toBe(
        'O novo computador chegou em São-Paulo trazendo bem-estar e um guarda-chuva muito antigo na segunda-feira perto do supermercado com anti-inflamatório.',
      );
    }
  });
});

describe('extractPdfChapters - cabeçalhos, rodapés e números de página', () => {
  it('remove cabeçalho/rodapé repetido (ignorando números) e números de página isolados', () => {
    const pages: PdfPageInput[] = [1, 2, 3, 4].map((p) =>
      makePage(p, [
        // Cabeçalho repetido no topo (y=770 -> yTop=30, dentro dos 14% superiores)
        makeItem(`Dom Casmurro   ${p}`, 200, 770, { h: 10, w: 180 }),
        // Corpo da página
        makeItem(`Texto principal exclusivo da página número ${p} com conteúdo real do livro.`, 60, 660, {
          h: 12,
          w: 480,
        }),
        makeItem(`Continuação do corpo na página ${p} sem repetição de cabeçalho.`, 60, 644, {
          h: 12,
          w: 400,
        }),
        // Rodapé repetido na base (y=42 -> yTop=758)
        makeItem('Editora Exemplo — Edição Especial', 180, 42, { h: 9, w: 220 }),
        // Número de página isolado na base (y=24 -> yTop=776)
        makeItem(`- ${p} -`, 285, 24, { h: 10, w: 30 }),
      ]),
    );

    const chapters = extractPdfChapters(pages);
    const allText = chapters
      .flatMap((c) => c.blocks)
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n');

    expect(allText).not.toContain('Dom Casmurro');
    expect(allText).not.toContain('Editora Exemplo');
    expect(allText).not.toContain('- 1 -');
    expect(allText).not.toContain('- 4 -');
    expect(allText).toContain('Texto principal exclusivo da página número 1');
    expect(allText).toContain('Texto principal exclusivo da página número 4');
  });
});

describe('extractPdfChapters - títulos e capítulos', () => {
  it('detecta títulos níveis 1, 2 e 3 relativos ao corpo e divide capítulos no nível 1', () => {
    const page1 = makePage(1, [
      makeItem('Capítulo 1: A Partida', 60, 720, { h: 22, fontName: 'Times-Bold' }),
      makeItem('Seção 1.1: Preparativos', 60, 680, { h: 17, fontName: 'Times-Bold' }),
      makeItem('Subseção: A Mala', 60, 650, { h: 14.5, fontName: 'Times-Bold' }),
      makeItem('O viajante arrumou tudo com cuidado antes de sair pela porta da frente.', 60, 620, { h: 12, w: 460 }),
      makeItem('A estrada era longa e seguia pelas colinas verdes até o horizonte.', 60, 604, { h: 12, w: 440 }),
    ]);

    const page2 = makePage(2, [
      makeItem('Capítulo 2: A Chegada', 60, 720, { h: 22, fontName: 'Times-Bold' }),
      makeItem('Ao entardecer avistou as luzes da vila e sorriu aliviado.', 60, 680, { h: 12, w: 450 }),
    ]);

    const chapters = extractPdfChapters([page1, page2]);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Capítulo 1: A Partida');
    expect(chapters[0].blocks[0]).toEqual({ t: 'h', level: 1, text: 'Capítulo 1: A Partida' });
    expect(chapters[0].blocks[1]).toEqual({ t: 'h', level: 2, text: 'Seção 1.1: Preparativos' });
    expect(chapters[0].blocks[2]).toEqual({ t: 'h', level: 3, text: 'Subseção: A Mala' });

    expect(chapters[1].title).toBe('Capítulo 2: A Chegada');
    expect(chapters[1].blocks[0]).toEqual({ t: 'h', level: 1, text: 'Capítulo 2: A Chegada' });
  });

  it('prioriza o sumário (outline) do PDF para títulos e cortes de capítulos', () => {
    const pages = [1, 2, 3, 4].map((p) =>
      makePage(p, [
        makeItem(`Conteúdo da página ${p} de um livro sem títulos grandes.`, 60, 680, { h: 12, w: 420 }),
      ]),
    );

    const chapters = extractPdfChapters(pages, {
      outline: [
        { title: 'Prólogo', pageNumber: 1, level: 0 },
        { title: 'Parte I', pageNumber: 3, level: 0 },
      ],
    });

    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Prólogo');
    expect(chapters[1].title).toBe('Parte I');
  });

  it('divide em capítulos de ~15 páginas quando não há títulos nem sumário', () => {
    const pages: PdfPageInput[] = [];
    for (let p = 1; p <= 32; p++) {
      pages.push(
        makePage(p, [
          makeItem(`Parágrafo único da página ${p} sem qualquer título detectável.`, 60, 680, { h: 12, w: 420 }),
        ]),
      );
    }

    const chapters = extractPdfChapters(pages);
    expect(chapters.map((c) => c.title)).toEqual(['Páginas 1–15', 'Páginas 16–30', 'Páginas 31–32']);
  });

  it('divide capítulos que excedem ~60 mil caracteres em "(cont.)"', () => {
    const longParagraph = 'A'.repeat(1200) + '.';
    const pages: PdfPageInput[] = [];
    for (let p = 1; p <= 60; p++) {
      const items: PdfTextItem[] = [];
      if (p === 1) items.push(makeItem('Capítulo Gigante', 60, 740, { h: 20, fontName: 'Times-Bold' }));
      items.push(makeItem(longParagraph, 60, 680, { h: 12, w: 480 }));
      pages.push(makePage(p, items));
    }

    const chapters = extractPdfChapters(pages);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters[0].title).toBe('Capítulo Gigante');
    expect(chapters[1].title).toBe('Capítulo Gigante (cont.)');
    for (const ch of chapters) {
      const total = ch.blocks.reduce((sum, b) => sum + ('text' in b ? b.text.length : 0), 0);
      expect(total).toBeLessThanOrEqual(60_000);
    }
  });
});

describe('extractPdfChapters - listas e estilos (runs)', () => {
  it('detecta listas não ordenadas e ordenadas como blocos li', () => {
    const page = makePage(1, [
      makeItem('• Primeiro item da lista com marcador circular', 60, 700, { w: 300 }),
      makeItem('- Segundo item com hífen', 60, 682, { w: 200 }),
      makeItem('▪ Terceiro item com quadrado', 60, 664, { w: 220 }),
      makeItem('1. Passo um da receita', 60, 640, { w: 180 }),
      makeItem('2. Passo dois da receita', 60, 622, { w: 180 }),
      makeItem('a) Alternativa alfa', 60, 598, { w: 150 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].blocks).toEqual([
      { t: 'li', text: 'Primeiro item da lista com marcador circular' },
      { t: 'li', text: 'Segundo item com hífen' },
      { t: 'li', text: 'Terceiro item com quadrado' },
      { t: 'li', text: 'Passo um da receita', ordered: true },
      { t: 'li', text: 'Passo dois da receita', ordered: true },
      { t: 'li', text: 'Alternativa alfa', ordered: true },
    ]);
  });

  it('gera runs de negrito e itálico pelo nome da fonte quando o parágrafo mistura estilos', () => {
    const page = makePage(1, [
      makeItem('Texto normal', 60, 700, { w: 72, fontName: 'Times-Roman' }),
      makeItem('em negrito', 138, 700, { w: 66, fontName: 'Times-Bold' }),
      makeItem('e também', 210, 700, { w: 54, fontName: 'Times-Roman' }),
      makeItem('em itálico.', 270, 700, { w: 62, fontName: 'Times-Italic' }),
      // Parágrafo simples sem estilos -> não deve emitir runs
      makeItem('Outro parágrafo totalmente simples sem formatação.', 60, 650, { w: 300, fontName: 'Times-Roman' }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].blocks).toHaveLength(2);

    const first = chapters[0].blocks[0];
    expect(first.t).toBe('p');
    if (first.t === 'p') {
      expect(first.text).toBe('Texto normal em negrito e também em itálico.');
      expect(first.runs).toBeDefined();
      expect(first.runs?.some((r) => r.b === 1 && r.s.includes('em negrito'))).toBe(true);
      expect(first.runs?.some((r) => r.i === 1 && r.s.includes('em itálico.'))).toBe(true);
      expect(first.runs?.map((r) => r.s).join('')).toBe(first.text);
    }

    const second = chapters[0].blocks[1];
    expect(second.t).toBe('p');
    if (second.t === 'p') {
      expect(second.runs).toBeUndefined();
    }
  });
});

describe('extractPdfChapters - duas colunas', () => {
  it('lê a coluna esquerda inteira antes da coluna direita preservando título de largura total', () => {
    const page = makePage(1, [
      // Título de largura total cruzando o centro da página
      makeItem('Artigo em Duas Colunas Completo', 140, 740, { h: 20, w: 320, fontName: 'Helvetica-Bold' }),
      // Coluna esquerda (x=50..270) e coluna direita (x=330..550) nas mesmas linhas de base
      makeItem('Esquerda linha um começa aqui', 50, 680, { w: 220 }),
      makeItem('Direita linha um começa aqui', 330, 680, { w: 220 }),
      makeItem('e continua na esquerda dois', 50, 664, { w: 220 }),
      makeItem('e continua na direita dois', 330, 664, { w: 220 }),
      makeItem('seguindo na esquerda três', 50, 648, { w: 220 }),
      makeItem('seguindo na direita três', 330, 648, { w: 220 }),
      makeItem('e termina na esquerda quatro.', 50, 632, { w: 180 }),
      makeItem('e termina na direita quatro.', 330, 632, { w: 180 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Artigo em Duas Colunas Completo');

    const bodyBlocks = chapters[0].blocks.filter((b) => b.t === 'p');
    expect(bodyBlocks).toHaveLength(2);
    if (bodyBlocks[0].t === 'p' && bodyBlocks[1].t === 'p') {
      expect(bodyBlocks[0].text).toBe(
        'Esquerda linha um começa aqui e continua na esquerda dois seguindo na esquerda três e termina na esquerda quatro.',
      );
      expect(bodyBlocks[1].text).toBe(
        'Direita linha um começa aqui e continua na direita dois seguindo na direita três e termina na direita quatro.',
      );
    }
  });
});
