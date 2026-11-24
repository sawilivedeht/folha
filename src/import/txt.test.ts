import { describe, expect, it } from 'vitest';
import { decodeText, parseTxt } from './txt';

describe('decodeText', () => {
  it('decodes UTF-8 without BOM', () => {
    const bytes = new TextEncoder().encode('Olá, coração!');
    expect(decodeText(bytes.buffer)).toBe('Olá, coração!');
  });

  it('decodes UTF-8 with BOM', () => {
    const payload = new TextEncoder().encode('Bom dia');
    const withBom = new Uint8Array(3 + payload.length);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(payload, 3);
    expect(decodeText(withBom.buffer)).toBe('Bom dia');
  });

  it('decodes UTF-16LE with BOM', () => {
    // BOM FF FE + "Oi" (0x4F 0x00 0x69 0x00)
    const buf = new Uint8Array([0xff, 0xfe, 0x4f, 0x00, 0x69, 0x00]).buffer;
    expect(decodeText(buf)).toBe('Oi');
  });

  it('decodes UTF-16BE with BOM', () => {
    // BOM FE FF + "Oi" (0x00 0x4F 0x00 0x69)
    const buf = new Uint8Array([0xfe, 0xff, 0x00, 0x4f, 0x00, 0x69]).buffer;
    expect(decodeText(buf)).toBe('Oi');
  });

  it('falls back to windows-1252 when UTF-8 is invalid', () => {
    // "coração" em windows-1252: 0xE7 = 'ç', 0xE3 = 'ã'
    const buf = new Uint8Array([0x63, 0x6f, 0x72, 0x61, 0xe7, 0xe3, 0x6f]).buffer;
    expect(decodeText(buf)).toBe('coração');
  });
});

describe('parseTxt', () => {
  it('extracts title from short first line and falls back to fileName for long first line', () => {
    const short = parseTxt('\uFEFFMemórias Póstumas\r\n\r\nPrimeiro parágrafo.', 'livro.txt');
    expect(short.title).toBe('Memórias Póstumas');

    const longFirst = 'Esta primeira linha é propositalmente muito longa e ultrapassa o limite de oitenta caracteres para título.';
    const fallback = parseTxt(`${longFirst}\n\nSegundo parágrafo.`, 'meu-livro.txt');
    expect(fallback.title).toBe('meu-livro');
  });

  it('reflows fixed-width wrapped lines (~60-80 cols) into paragraphs', () => {
    const wrapped = [
      'Título do Livro',
      '',
      'Esta é a primeira linha de um parágrafo longo que foi quebrado em',
      'largura fixa de aproximadamente setenta colunas para caber em telas',
      'antigas de terminal sem quebra automática de linha no leitor.',
      '',
      'Já este segundo parágrafo também segue exatamente o mesmo padrão de',
      'formatação com linhas de sessenta a oitenta caracteres separados por',
      'uma linha em branco entre os parágrafos do texto original.',
    ].join('\n');

    const book = parseTxt(wrapped, 'wrapped.txt');
    expect(book.chapters).toHaveLength(1);
    const paragraphs = book.chapters[0].blocks.filter((b) => b.t === 'p');
    expect(paragraphs).toHaveLength(3); // título + 2 parágrafos refluídos
    expect(paragraphs[1].text).toContain('largura fixa de aproximadamente setenta colunas para caber em telas antigas');
    expect(paragraphs[2].text).toContain('formatação com linhas de sessenta a oitenta caracteres separados por uma linha');
  });

  it('detects chapters by headings and uppercase lines', () => {
    const text = [
      'Romance Exemplo',
      '',
      'Capítulo 1',
      'Texto do primeiro capítulo.',
      '',
      'CAPÍTULO II',
      'Texto do segundo capítulo.',
      '',
      'Chapter 3',
      'Text of chapter three.',
      '',
      'PARTE FINAL',
      '',
      'Desfecho da história.',
    ].join('\n');

    const book = parseTxt(text, 'romance.txt');
    expect(book.title).toBe('Romance Exemplo');
    // A folha de rosto curta ("Romance Exemplo") entra no 1º capítulo em vez de virar capítulo próprio.
    expect(book.chapters.map((c) => c.title)).toEqual([
      'Capítulo 1',
      'CAPÍTULO II',
      'Chapter 3',
      'PARTE FINAL',
    ]);
    expect(book.chapters[0].blocks[0]).toEqual({ t: 'p', text: 'Romance Exemplo' });
    expect(book.chapters[0].blocks[1]).toEqual({ t: 'h', level: 1, text: 'Capítulo 1' });
    expect(book.chapters[0].blocks[2]).toEqual({ t: 'p', text: 'Texto do primeiro capítulo.' });
  });

  it('splits into ~40k char "Parte N" chapters when no headings exist', () => {
    const para = 'A'.repeat(25_000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const book = parseTxt(text, 'grande.txt');
    expect(book.chapters.map((c) => c.title)).toEqual(['Parte 1', 'Parte 2', 'Parte 3']);
  });
});

describe('parseTxt: falsos positivos de capítulos e capítulos vazios (achado 5)', () => {
  it('rejeita prosa iniciada por "Capítulo" e mantém títulos legítimos ("CAPÍTULO I", "Capítulo 1 - O começo")', () => {
    const falsoPositivo = [
      'Diário de Leituras',
      '',
      'Capítulo interessante aquele que lemos ontem na biblioteca.',
      'Depois voltamos para casa comentando a narrativa.',
    ].join('\n');
    const semCaps = parseTxt(falsoPositivo, 'diario.txt');
    expect(semCaps.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'h')).toEqual([]);

    const legitimo = [
      'Romance',
      '',
      'CAPÍTULO I',
      '',
      'Primeiro parágrafo.',
      '',
      'Capítulo 1 - O começo',
      '',
      'Segundo parágrafo.',
    ].join('\n');
    const comCaps = parseTxt(legitimo, 'romance.txt');
    expect(comCaps.chapters.map((c) => c.title)).toEqual(['CAPÍTULO I', 'Capítulo 1 - O começo']);
  });

  it('rejeita "Introdução de novas técnicas..." em texto refluído e mantém "Introdução" isolada', () => {
    const prosaRefluida = [
      'Artigo Técnico',
      '',
      'Introdução de novas técnicas agrícolas no interior paulista mudou',
      'profundamente a forma como pequenos produtores planejavam as safras',
      'ao longo de toda a segunda metade do século passado naquela região.',
      '',
      'Outro parágrafo também quebrado em largura fixa de setenta colunas',
      'para ativar o detector de refluxo e garantir que a primeira linha',
      'acima não seja arrancada do parágrafo como título de capítulo.',
    ].join('\n');
    const bookProsa = parseTxt(prosaRefluida, 'artigo.txt');
    expect(bookProsa.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'h')).toEqual([]);

    const legitimo = ['Manual', '', 'Introdução', '', 'Texto introdutório.', '', 'Epílogo', '', 'Conclusão.'].join('\n');
    expect(parseTxt(legitimo, 'manual.txt').chapters.map((c) => c.title)).toEqual(['Introdução', 'Epílogo']);
  });

  it('rejeita palavras minúsculas com letras de romanos ("civil", "mil", "vi") e mantém "PARTE II" e "I" isolado', () => {
    const falsoPositivo = [
      'Ensaio',
      '',
      'Parte civil do processo continuava parada no fórum.',
      '',
      'Livro mil vezes lido pela crítica literária.',
      '',
      'Parte vi da carta mencionava a viagem.',
    ].join('\n');
    expect(parseTxt(falsoPositivo, 'ensaio.txt').chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'h')).toEqual([]);

    const legitimo = ['Obra', '', 'PARTE II', '', 'Texto da parte.', '', 'I', '', 'Primeiro trecho.'].join('\n');
    expect(parseTxt(legitimo, 'obra.txt').chapters.map((c) => c.title)).toEqual(['PARTE II', 'I']);
  });

  it('rejeita diálogos gritados em caixa alta e mantém títulos em caixa alta sem pontuação final', () => {
    const dialogo = [
      'Conto',
      '',
      'CAPÍTULO I',
      '',
      'Ele abriu a porta correndo.',
      '',
      '— NÃO!',
      '',
      '— SOCORRO!',
      '',
      'E então tudo ficou em silêncio.',
    ].join('\n');
    const bookDialogo = parseTxt(dialogo, 'conto.txt');
    expect(bookDialogo.chapters.map((c) => c.title)).toEqual(['CAPÍTULO I']);
    expect(bookDialogo.chapters[0].blocks.filter((b) => b.t === 'p').map((b) => b.text)).toContain('— NÃO!');
    expect(bookDialogo.chapters[0].blocks.filter((b) => b.t === 'p').map((b) => b.text)).toContain('— SOCORRO!');

    const legitimo = ['Conto', '', 'CAPÍTULO I', '', 'Começo.', '', 'PARTE FINAL', '', 'Desfecho.'].join('\n');
    expect(parseTxt(legitimo, 'conto2.txt').chapters.map((c) => c.title)).toEqual(['CAPÍTULO I', 'PARTE FINAL']);
  });

  it('não cria capítulos vazios em folha de rosto em caixa alta nem em títulos seguidos no modo reflow', () => {
    const folhaDeRosto = [
      'DOM CASMURRO',
      '',
      'MACHADO DE ASSIS',
      '',
      'CAPÍTULO I',
      '',
      'Uma noite destas, vindo da cidade para o Engenho Novo.',
      '',
      'CAPÍTULO II',
      '',
      'Agora que expliquei o título, passo a escrever o livro.',
    ].join('\n');
    const book = parseTxt(folhaDeRosto, 'dom-casmurro.txt');
    expect(book.title).toBe('DOM CASMURRO');
    expect(book.chapters.map((c) => c.title)).toEqual(['CAPÍTULO I', 'CAPÍTULO II']);
    expect(book.chapters.every((c) => c.blocks.some((b) => b.t === 'p'))).toBe(true);

    const reflowSubtitulo = [
      'CAPÍTULO I',
      'DO TÍTULO',
      '',
      'Esta é a primeira linha de um parágrafo longo que foi quebrado em',
      'largura fixa de aproximadamente setenta colunas para caber em telas',
      'antigas de terminal sem quebra automática de linha no leitor.',
      '',
      'Já este segundo parágrafo também segue exatamente o mesmo padrão de',
      'formatação com linhas de sessenta a oitenta caracteres separados por',
      'uma linha em branco entre os parágrafos do texto original.',
    ].join('\n');
    const bookReflow = parseTxt(reflowSubtitulo, 'reflow.txt');
    expect(bookReflow.chapters.map((c) => c.title)).toEqual(['CAPÍTULO I']);
    expect(bookReflow.chapters[0].blocks.filter((b) => b.t === 'p')[0]).toEqual({ t: 'p', text: 'DO TÍTULO' });
  });
});

describe('parseTxt: arquivos Markdown .md (achado 11)', () => {
  it('reconhece cabeçalhos ATX (#, ##, ###) em .md e remove .md do título de fallback', () => {
    const primeiraLonga =
      'Esta primeira linha é propositalmente muito longa e ultrapassa o limite de oitenta caracteres para acionar o fallback.';
    const md = [
      primeiraLonga,
      '',
      '# Capítulo 1',
      '',
      'Texto do primeiro capítulo.',
      '',
      '## Introdução',
      '',
      'Detalhes da introdução.',
      '',
      '### Nota final ###',
      '',
      'Encerramento.',
    ].join('\n');

    const book = parseTxt(md, 'notas.md');
    expect(book.title).toBe('notas');
    expect(book.chapters.map((c) => c.title)).toEqual(['Capítulo 1', 'Introdução', 'Nota final']);
    expect(book.chapters[0].blocks.find((b) => b.t === 'h')).toEqual({ t: 'h', level: 1, text: 'Capítulo 1' });
    expect(book.chapters[1].blocks.find((b) => b.t === 'h')).toEqual({ t: 'h', level: 2, text: 'Introdução' });
    expect(book.chapters[2].blocks.find((b) => b.t === 'h')).toEqual({ t: 'h', level: 3, text: 'Nota final' });
    expect(parseTxt('\n', '.md').title).toBe('Sem título');
  });

  it('não trata cabeçalhos ATX (#, ##, ###) como capítulos em arquivos .txt', () => {
    const txt = ['# Isto não é título Markdown', '', '## Nem isto', '', 'Texto comum.'].join('\n');
    const book = parseTxt(txt, 'notas.txt');
    expect(book.chapters.flatMap((c) => c.blocks).filter((b) => b.t === 'h')).toEqual([]);
    expect(book.chapters[0].blocks[0]).toEqual({ t: 'p', text: '# Isto não é título Markdown' });
  });
});
