import { describe, expect, it } from 'vitest';
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

function collectText(pages: PdfPageInput[], outline?: Array<{ title: string; pageNumber: number; level?: number }>): string {
  const chapters = extractPdfChapters(pages, outline ? { outline } : {});
  return chapters
    .flatMap((c) => c.blocks)
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
}

describe('Achado 5 — cabeçalhos, rodapés e números de página', () => {
  it('remove cabeçalho alinhado à direita e rodapé alinhado à esquerda em páginas de duas colunas', () => {
    const pages = [1, 2, 3, 4].map((p) =>
      makePage(p, [
        // Cabeçalho na coluna direita (yTop = 30) — na ordem de leitura fica no meio do array de linhas
        makeItem('Revista Brasileira de Estudos', 360, 770, { h: 10, w: 180 }),
        // Corpo em duas colunas (yTop = 90..154)
        makeItem(`Esquerda linha um da página ${p} aqui`, 50, 710, { w: 210 }),
        makeItem(`Direita linha um da página ${p} aqui`, 330, 710, { w: 210 }),
        makeItem(`esquerda dois da página ${p} segue`, 50, 694, { w: 210 }),
        makeItem(`direita dois da página ${p} segue`, 330, 694, { w: 210 }),
        makeItem(`esquerda três da página ${p} continua`, 50, 678, { w: 210 }),
        makeItem(`direita três da página ${p} continua`, 330, 678, { w: 210 }),
        makeItem(`esquerda quatro da página ${p} fecha.`, 50, 662, { w: 210 }),
        makeItem(`direita quatro da página ${p} fecha.`, 330, 662, { w: 210 }),
        // Rodapé na coluna esquerda (yTop = 770) — fica longe do fim do array de linhas
        makeItem('ISSN 1234-5678 — Ano IV', 50, 30, { h: 10, w: 180 }),
      ]),
    );

    const text = collectText(pages);
    expect(text).not.toContain('Revista Brasileira de Estudos');
    expect(text).not.toContain('ISSN 1234-5678');
    expect(text).toContain('Esquerda linha um da página 1');
    expect(text).toContain('Direita linha um da página 4');
    expect(text.indexOf('Esquerda linha um da página 1')).toBeLessThan(text.indexOf('Direita linha um da página 1'));
  });

  it('preserva linhas reais de corpo em margens padrão ("Art. 1", "Exercício 1") sem removê-las como cabeçalho', () => {
    const a4W = 595;
    const a4H = 842;
    // Margem superior padrão ~2,5 cm (yTop = 72 ≈ 8,55% de 842pt)
    const pages: PdfPageInput[] = [];
    for (let p = 1; p <= 10; p++) {
      let firstLine = `Continuação natural do texto corrido na página número ${p} do documento.`;
      if (p === 1) firstLine = 'Art. 1';
      else if (p === 3) firstLine = 'Art. 2';
      else if (p === 5) firstLine = 'Art. 3';
      else if (p === 2) firstLine = 'Exercício 1';
      else if (p === 4) firstLine = 'Exercício 2';
      else if (p === 6) firstLine = 'Exercício 3';

      pages.push(
        makePage(
          p,
          [
            makeItem(firstLine, 60, a4H - 72, { h: 12, w: 460 }),
            makeItem(`Corpo imediato da página ${p} logo abaixo na entrelinha normal do texto.`, 60, a4H - 88, {
              h: 12,
              w: 460,
            }),
            makeItem(`Mais conteúdo real da página ${p} para compor o parágrafo completo.`, 60, a4H - 104, {
              h: 12,
              w: 460,
            }),
          ],
          a4W,
          a4H,
        ),
      );
    }

    const text = collectText(pages);
    expect(text).toContain('Art. 1');
    expect(text).toContain('Art. 2');
    expect(text).toContain('Art. 3');
    expect(text).toContain('Exercício 1');
    expect(text).toContain('Exercício 2');
    expect(text).toContain('Exercício 3');
  });

  it('preserva anos isolados, títulos numéricos/romanos no tamanho do corpo e palavras curtas ("vi", "li", "di", "mix", "CD", "cm")', () => {
    const pages: PdfPageInput[] = [
      makePage(1, [
        makeItem('1984', 60, 740, { h: 12, w: 40 }),
        makeItem('Corpo principal da primeira página com narrativa real do livro.', 60, 690, { h: 12, w: 460 }),
        makeItem('Segunda linha do corpo na primeira página.', 60, 674, { h: 12, w: 300 }),
        makeItem('vi', 60, 70, { h: 12, w: 16 }),
      ]),
      makePage(2, [
        makeItem('I', 60, 740, { h: 12, w: 10 }),
        makeItem('Corpo principal da segunda página com texto contínuo.', 60, 690, { h: 12, w: 460 }),
        makeItem('Segunda linha do corpo na segunda página.', 60, 674, { h: 12, w: 300 }),
        makeItem('li', 60, 86, { h: 12, w: 14 }),
        makeItem('cm', 60, 70, { h: 12, w: 20 }),
      ]),
      makePage(3, [
        makeItem('Corpo principal da terceira página sem título curto no topo.', 60, 690, { h: 12, w: 460 }),
        makeItem('Segunda linha do corpo na terceira página.', 60, 674, { h: 12, w: 300 }),
        makeItem('CD', 60, 86, { h: 12, w: 22 }),
        makeItem('mix', 60, 70, { h: 12, w: 24 }),
      ]),
      makePage(4, [
        makeItem('II', 60, 740, { h: 12, w: 16 }),
        makeItem('Corpo principal da quarta página com continuação da história.', 60, 690, { h: 12, w: 460 }),
        makeItem('Segunda linha do corpo na quarta página.', 60, 674, { h: 12, w: 300 }),
        makeItem('di', 60, 70, { h: 12, w: 14 }),
      ]),
      makePage(5, [
        makeItem('1', 60, 740, { h: 12, w: 10 }),
        makeItem('Corpo principal da quinta página encerrando a amostra.', 60, 690, { h: 12, w: 460 }),
        makeItem('Segunda linha do corpo na quinta página.', 60, 674, { h: 12, w: 300 }),
      ]),
    ];

    const text = collectText(pages);
    expect(text).toContain('1984');
    expect(text).toMatch(/\bI\b/);
    expect(text).toMatch(/\bII\b/);
    expect(text).toMatch(/\b1\b/);
    expect(text).toMatch(/\bvi\b/);
    expect(text).toMatch(/\bli\b/);
    expect(text).toMatch(/\bdi\b/);
    expect(text).toMatch(/\bmix\b/);
    expect(text).toMatch(/\bCD\b/);
    expect(text).toMatch(/\bcm\b/);
  });

  it('ainda remove cabeçalho repetido legítimo, rodapé repetido e números romanos com traços ou em sequência', () => {
    const romans = ['i', 'ii', 'iii', 'iv'];
    const pagesDecorated = romans.map((rom, idx) =>
      makePage(idx + 1, [
        makeItem('Memórias Póstumas', 220, 770, { h: 10, w: 140 }),
        makeItem(`Texto autêntico do prefácio na página ${idx + 1}.`, 60, 680, { h: 12, w: 420 }),
        makeItem(`Segunda linha do prefácio na página ${idx + 1}.`, 60, 664, { h: 12, w: 400 }),
        makeItem(`- ${rom} -`, 280, 28, { h: 10, w: 40 }),
      ]),
    );

    const textDecorated = collectText(pagesDecorated);
    expect(textDecorated).not.toContain('Memórias Póstumas');
    expect(textDecorated).not.toContain('- iv -');
    expect(textDecorated).not.toContain('- i -');
    expect(textDecorated).toContain('Texto autêntico do prefácio na página 4.');

    const pagesBareRoman = romans.map((rom, idx) =>
      makePage(idx + 1, [
        makeItem(`Conteúdo real da folha preliminar ${idx + 1}.`, 60, 680, { h: 12, w: 420 }),
        makeItem(`Segunda linha da folha preliminar ${idx + 1}.`, 60, 664, { h: 12, w: 400 }),
        makeItem(rom, 290, 28, { h: 10, w: 20 }),
      ]),
    );

    const textBareRoman = collectText(pagesBareRoman);
    expect(textBareRoman).not.toMatch(/^(?:i|ii|iii|iv)$/m);
    expect(textBareRoman).toContain('Conteúdo real da folha preliminar 4.');
  });
});

describe('Achado 6 — desifenização em português e normalização NFC', () => {
  it('remove hífens espúrios de palavras comuns com sílabas que coincidem com prefixos ou clíticos', () => {
    const page = makePage(1, [
      makeItem('Um bom ex-', 60, 720, { w: 480 }),
      makeItem('emplo vem sem-', 60, 704, { w: 480 }),
      makeItem('pre na sem-', 60, 688, { w: 480 }),
      makeItem('ana do pró-', 60, 672, { w: 480 }),
      makeItem('ximo pró-', 60, 656, { w: 480 }),
      makeItem('prio pré-', 60, 640, { w: 480 }),
      makeItem('dio sem mal-', 60, 624, { w: 480 }),
      makeItem('dade no vidro quebra-', 60, 608, { w: 480 }),
      makeItem('do com bate-', 60, 592, { w: 480 }),
      makeItem('ria contra a tira-', 60, 576, { w: 480 }),
      makeItem('nia na vira-', 60, 560, { w: 480 }),
      makeItem('da em cada deta-', 60, 544, { w: 480 }),
      makeItem('lhe de quem esco-', 60, 528, { w: 480 }),
      makeItem('lhe que traba-', 60, 512, { w: 480 }),
      makeItem('lhe em grande par-', 60, 496, { w: 480 }),
      makeItem('te dos planos moder-', 60, 480, { w: 480 }),
      makeItem('nos eter-', 60, 464, { w: 480 }),
      makeItem('nos e inter-', 60, 448, { w: 480 }),
      makeItem('nos.', 60, 432, { w: 40 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    const blk = chapters[0].blocks[0];
    expect(blk.t).toBe('p');
    if (blk.t === 'p') {
      expect(blk.text).toBe(
        'Um bom exemplo vem sempre na semana do próximo próprio prédio sem maldade no vidro quebrado com bateria contra a tirania na virada em cada detalhe de quem escolhe que trabalhe em grande parte dos planos modernos eternos e internos.',
      );
    }
  });

  it('mantém o hífen em clíticos verbais frequentes terminados em -a, -e, -ê e -á', () => {
    const page = makePage(1, [
      makeItem('Aqui trata-', 60, 700, { w: 480 }),
      makeItem('se de algo que pode-', 60, 684, { w: 480 }),
      makeItem('se ver e sabe-', 60, 668, { w: 480 }),
      makeItem('se como chama-', 60, 652, { w: 480 }),
      makeItem('se quando torna-', 60, 636, { w: 480 }),
      makeItem('se claro e vê-', 60, 620, { w: 480 }),
      makeItem('se que dá-', 60, 604, { w: 480 }),
      makeItem('se valor ao texto.', 60, 588, { w: 160 }),
    ]);

    const chapters = extractPdfChapters([page]);
    const blk = chapters[0].blocks[0];
    expect(blk.t).toBe('p');
    if (blk.t === 'p') {
      expect(blk.text).toBe(
        'Aqui trata-se de algo que pode-se ver e sabe-se como chama-se quando torna-se claro e vê-se que dá-se valor ao texto.',
      );
    }
  });

  it('normaliza acentos decompostos (NFD) para NFC ao desifenizar e ao casar títulos do sumário', () => {
    expect(normalizePdfText('informac\u0327a\u0303o')).toBe('informação');

    const page = makePage(1, [
      makeItem('Introduc\u0327a\u0303o', 60, 740, { h: 20, w: 140, fontName: 'Times-Bold' }),
      makeItem('A primeira pa\u0301-', 60, 700, { w: 480 }),
      makeItem('gina trata das estac\u0327o\u0303-', 60, 684, { w: 480 }),
      makeItem('es do ano.', 60, 668, { w: 100 }),
    ]);

    const chapters = extractPdfChapters([page], {
      outline: [{ title: 'Introdução', pageNumber: 1, level: 0 }],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Introdução');
    const para = chapters[0].blocks.find((b) => b.t === 'p');
    expect(para).toBeDefined();
    if (para && para.t === 'p') {
      expect(para.text).toBe('A primeira página trata das estações do ano.');
    }
  });

  it('mantém o hífen em compostos legítimos ("bem-vindo", "guarda-chuva", "ex-presidente", "mal-estar") e clíticos', () => {
    const page = makePage(1, [
      makeItem('Seja bem-', 60, 720, { w: 480 }),
      makeItem('vindo com o guarda-', 60, 704, { w: 480 }),
      makeItem('chuva do ex-', 60, 688, { w: 480 }),
      makeItem('presidente sem mal-', 60, 672, { w: 480 }),
      makeItem('estar na pré-', 60, 656, { w: 480 }),
      makeItem('história do quebra-', 60, 640, { w: 480 }),
      makeItem('cabeça conforme disse-', 60, 624, { w: 480 }),
      makeItem('lhe para ajudar-', 60, 608, { w: 480 }),
      makeItem('nos.', 60, 592, { w: 40 }),
    ]);

    const chapters = extractPdfChapters([page]);
    const blk = chapters[0].blocks[0];
    expect(blk.t).toBe('p');
    if (blk.t === 'p') {
      expect(blk.text).toBe(
        'Seja bem-vindo com o guarda-chuva do ex-presidente sem mal-estar na pré-história do quebra-cabeça conforme disse-lhe para ajudar-nos.',
      );
    }
  });
});

describe('Achado 9 — títulos de largura total em páginas de duas colunas', () => {
  it('mantém inteiro um título centralizado emitido palavra-a-palavra cujo espaço cai sobre a calha', () => {
    const page = makePage(1, [
      // Dois fragmentos de título cuja lacuna (280..286) cai exatamente sobre splitX (~283)
      makeItem('Artigo em', 140, 740, { h: 20, w: 140, fontName: 'Helvetica-Bold' }),
      makeItem('Duas Colunas', 286, 740, { h: 20, w: 154, fontName: 'Helvetica-Bold' }),
      // Coluna esquerda (x=50..260) e coluna direita (x=306..516)
      makeItem('Esquerda linha um começa aqui', 50, 680, { w: 210 }),
      makeItem('Direita linha um começa aqui', 306, 680, { w: 210 }),
      makeItem('e continua na esquerda dois', 50, 664, { w: 210 }),
      makeItem('e continua na direita dois', 306, 664, { w: 210 }),
      makeItem('seguindo na esquerda três', 50, 648, { w: 210 }),
      makeItem('seguindo na direita três', 306, 648, { w: 210 }),
      makeItem('e termina na esquerda quatro.', 50, 632, { w: 180 }),
      makeItem('e termina na direita quatro.', 306, 632, { w: 180 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Artigo em Duas Colunas');
    expect(chapters[0].blocks[0]).toEqual({ t: 'h', level: 1, text: 'Artigo em Duas Colunas' });

    const bodyBlocks = chapters[0].blocks.filter((b) => b.t === 'p');
    expect(bodyBlocks).toHaveLength(2);
    if (bodyBlocks[0].t === 'p' && bodyBlocks[1].t === 'p') {
      expect(bodyBlocks[0].text).toContain('Esquerda linha um começa aqui');
      expect(bodyBlocks[1].text).toContain('Direita linha um começa aqui');
    }
  });

  it('não funde cabeçalhos independentes das colunas esquerda e direita separados pela calha', () => {
    const page = makePage(1, [
      makeItem('Seção Esquerda', 50, 710, { h: 16, w: 150, fontName: 'Helvetica-Bold' }),
      makeItem('Seção Direita', 330, 710, { h: 16, w: 150, fontName: 'Helvetica-Bold' }),
      makeItem('Texto da coluna esquerda um', 50, 680, { w: 210 }),
      makeItem('Texto da coluna direita um', 330, 680, { w: 210 }),
      makeItem('continua na esquerda dois', 50, 664, { w: 210 }),
      makeItem('continua na direita dois', 330, 664, { w: 210 }),
      makeItem('fecha na esquerda três.', 50, 648, { w: 180 }),
      makeItem('fecha na direita três.', 330, 648, { w: 180 }),
    ]);

    const chapters = extractPdfChapters([page]);
    const blocks = chapters.flatMap((c) => c.blocks);
    const headings = blocks.filter((b) => b.t === 'h').map((b) => b.text);
    expect(headings).toEqual(['Seção Esquerda', 'Seção Direita']);

    const fullText = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(fullText.indexOf('fecha na esquerda três.')).toBeLessThan(fullText.indexOf('Seção Direita'));
  });
});

describe('Achado 10(a) — falas com travessão vs. listas com hífen', () => {
  it('mantém diálogos de romance com "– " e "- " como parágrafos preservando o travessão', () => {
    const page = makePage(1, [
      makeItem('Ela abriu a porta devagar e olhou para o corredor silencioso.', 60, 720, { w: 460 }),
      makeItem('– Bom dia, disse ela.', 60, 704, { w: 140 }),
      makeItem('– Tudo bem com você?', 60, 688, { w: 150 }),
      makeItem('– Muito bem, respondeu o vizinho.', 60, 672, { w: 220 }),
      makeItem('Ele caminhou até a varanda e sorriu.', 60, 644, { w: 260 }),
      makeItem('– Bom dia.', 60, 628, { w: 80 }),
      makeItem('– Entre, por favor.', 60, 612, { w: 120 }),
      makeItem('– Obrigado.', 60, 596, { w: 80 }),
      makeItem('Do outro lado da sala, Pedro perguntou em voz baixa:', 60, 568, { w: 340 }),
      makeItem('- Onde você deixou o livro?', 60, 552, { w: 180 }),
      makeItem('- Na estante da sala, respondeu Maria.', 60, 536, { w: 240 }),
    ]);

    const chapters = extractPdfChapters([page]);
    const blocks = chapters[0].blocks;
    expect(blocks.some((b) => b.t === 'li')).toBe(false);
    const texts = blocks.map((b) => ('text' in b ? b.text : ''));
    expect(texts).toContain('– Bom dia, disse ela.');
    expect(texts).toContain('– Tudo bem com você?');
    expect(texts).toContain('– Muito bem, respondeu o vizinho.');
    expect(texts).toContain('– Bom dia.');
    expect(texts).toContain('– Entre, por favor.');
    expect(texts).toContain('– Obrigado.');
    expect(texts).toContain('- Onde você deixou o livro?');
    expect(texts).toContain('- Na estante da sala, respondeu Maria.');
  });

  it('continua reconhecendo listas legítimas com "-" como blocos li', () => {
    const page = makePage(1, [
      makeItem('Principais recursos do leitor:', 60, 720, { w: 220 }),
      makeItem('- Leitura offline no aparelho', 76, 702, { w: 200 }),
      makeItem('- Temas claro, sépia e escuro', 76, 684, { w: 200 }),
      makeItem('- Marcadores por página', 76, 666, { w: 180 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters[0].blocks).toEqual([
      { t: 'p', text: 'Principais recursos do leitor:' },
      { t: 'li', text: 'Leitura offline no aparelho' },
      { t: 'li', text: 'Temas claro, sépia e escuro' },
      { t: 'li', text: 'Marcadores por página' },
    ]);
  });
});

describe('Achado 12 — fake bold em glifos estreitos e splitByOutline na mesma página', () => {
  it('não apaga letras estreitas dobradas ("ll", "ii") em corpo pequeno glifo-a-glifo', () => {
    const page = makePage(1, [
      makeItem('a', 60, 700, { h: 6, w: 2.8 }),
      makeItem('l', 62.8, 700, { h: 6, w: 1.35 }),
      makeItem('l', 64.15, 700, { h: 6, w: 1.35 }),
      makeItem('i', 65.5, 700, { h: 6, w: 1.35 }),
      makeItem('i', 66.85, 700, { h: 6, w: 1.35 }),
    ]);

    const chapters = extractPdfChapters([page]);
    expect(chapters).toHaveLength(1);
    const blk = chapters[0].blocks[0];
    expect(blk).toEqual({ t: 'p', text: 'allii' });
  });

  it('ainda deduplica fake bold legítimo por sobreimpressão marcando negrito', () => {
    const page = makePage(1, [
      makeItem('Aviso', 60, 700, { h: 12, w: 32 }),
      makeItem('Aviso', 60.25, 700, { h: 12, w: 32 }),
      makeItem('importante.', 98, 700, { h: 12, w: 64 }),
    ]);

    const chapters = extractPdfChapters([page]);
    const blk = chapters[0].blocks[0];
    expect(blk.t).toBe('p');
    if (blk.t === 'p') {
      expect(blk.text).toBe('Aviso importante.');
      expect(blk.runs?.some((r) => r.b === 1 && r.s.includes('Aviso'))).toBe(true);
    }
  });

  it('não fatia capítulo no meio quando duas entradas do sumário caem na mesma página sem títulos distintos', () => {
    const page1 = makePage(1, [
      makeItem('Primeiro parágrafo da seção A na página um.', 60, 700, { w: 320 }),
      makeItem('Segundo parágrafo da seção A na página um.', 60, 650, { w: 320 }),
      makeItem('Terceiro parágrafo da seção A na página um.', 60, 600, { w: 320 }),
    ]);
    const page2 = makePage(2, [
      makeItem('Primeiro parágrafo da seção C na página dois.', 60, 700, { w: 320 }),
      makeItem('Segundo parágrafo da seção C na página dois.', 60, 650, { w: 320 }),
    ]);

    const chapters = extractPdfChapters([page1, page2], {
      outline: [
        { title: 'Seção A', pageNumber: 1, level: 0 },
        { title: 'Seção B', pageNumber: 1, level: 0 },
        { title: 'Seção C', pageNumber: 2, level: 0 },
      ],
    });

    expect(chapters.map((c) => c.title)).toEqual(['Seção A', 'Seção C']);
    expect(chapters[0].blocks).toHaveLength(3);
    expect(chapters[1].blocks).toHaveLength(2);

    // Também não desloca a segunda entrada para a página seguinte quando a página tem apenas 1 bloco.
    const singleBlockPage1 = makePage(1, [makeItem('Parágrafo único na página um.', 60, 700, { w: 260 })]);
    const singleChapters = extractPdfChapters([singleBlockPage1, page2], {
      outline: [
        { title: 'Seção A', pageNumber: 1, level: 0 },
        { title: 'Seção B', pageNumber: 1, level: 0 },
      ],
    });
    expect(singleChapters.map((c) => c.title)).toEqual(['Seção A']);
    expect(singleChapters[0].blocks).toHaveLength(3);
  });

  it('continua dividindo duas entradas do sumário na mesma página quando existem headings distintos', () => {
    const page1 = makePage(1, [
      makeItem('Seção A', 60, 740, { h: 20, w: 100, fontName: 'Times-Bold' }),
      makeItem('Conteúdo exclusivo da seção A.', 60, 700, { w: 260 }),
      makeItem('Seção B', 60, 640, { h: 20, w: 100, fontName: 'Times-Bold' }),
      makeItem('Conteúdo exclusivo da seção B.', 60, 600, { w: 260 }),
    ]);

    const chapters = extractPdfChapters([page1], {
      outline: [
        { title: 'Seção A', pageNumber: 1, level: 0 },
        { title: 'Seção B', pageNumber: 1, level: 0 },
      ],
    });

    expect(chapters.map((c) => c.title)).toEqual(['Seção A', 'Seção B']);
    expect(chapters[0].blocks).toEqual([
      { t: 'h', level: 1, text: 'Seção A' },
      { t: 'p', text: 'Conteúdo exclusivo da seção A.' },
    ]);
    expect(chapters[1].blocks).toEqual([
      { t: 'h', level: 1, text: 'Seção B' },
      { t: 'p', text: 'Conteúdo exclusivo da seção B.' },
    ]);
  });

  it('divide duas entradas do sumário na mesma página quando os títulos aparecem como parágrafos no corpo e promove-os a h', () => {
    const page1 = makePage(1, [
      makeItem('1.1 Descrição e objetivos do objeto de aprendizagem', 60, 740, { h: 12, w: 300, fontName: 'Times-Bold' }),
      makeItem('Este objeto de aprendizagem apresenta conceitos de frações para o quinto ano.', 60, 710, {
        h: 12,
        w: 420,
      }),
      makeItem('1.2 Eixo da BNCC e habilidades', 60, 670, { h: 12, w: 200, fontName: 'Times-Bold' }),
      makeItem('As atividades trabalham leitura, escrita e comparação de números racionais.', 60, 640, {
        h: 12,
        w: 420,
      }),
    ]);

    const chapters = extractPdfChapters([page1], {
      outline: [
        { title: '1.1 Descrição e objetivos do objeto de aprendizagem', pageNumber: 1, level: 0 },
        { title: '1.2 Eixo da BNCC e habilidades', pageNumber: 1, level: 0 },
      ],
    });

    expect(chapters.map((c) => c.title)).toEqual([
      '1.1 Descrição e objetivos do objeto de aprendizagem',
      '1.2 Eixo da BNCC e habilidades',
    ]);
    expect(chapters[0].blocks).toEqual([
      { t: 'h', level: 1, text: '1.1 Descrição e objetivos do objeto de aprendizagem' },
      { t: 'p', text: 'Este objeto de aprendizagem apresenta conceitos de frações para o quinto ano.' },
    ]);
    expect(chapters[1].blocks).toEqual([
      { t: 'h', level: 1, text: '1.2 Eixo da BNCC e habilidades' },
      { t: 'p', text: 'As atividades trabalham leitura, escrita e comparação de números racionais.' },
    ]);
  });
});
