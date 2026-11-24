import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import type { Block } from '../types';
import {
  WORDS_PER_MINUTE,
  calcBlockPage,
  calcBookPercent,
  calcTotalPages,
  clampSettings,
  countChapterWords,
  estimateChapterMinutesLeft,
  extractExcerpt,
  formatRemainingTime,
  fractionToPage,
  percentToTarget,
} from './progress';

describe('calcTotalPages', () => {
  it('calcula corretamente o número de páginas a partir de scrollWidth, largura útil e gap', () => {
    // 1 página: scrollWidth = 320, gap = 40, step = 360
    expect(calcTotalPages(320, 320, 40)).toBe(1);
    // 3 páginas: scrollWidth = 3 * 320 + 2 * 40 = 1040
    expect(calcTotalPages(1040, 320, 40)).toBe(3);
    // Margem máxima (48px => gap 96px), largura útil 224, step 320, 5 páginas => 5*224 + 4*96 = 1504
    expect(calcTotalPages(1504, 224, 96)).toBe(5);
    // Layout fixo (gap = 0), 4 páginas de 360px
    expect(calcTotalPages(1440, 360, 0)).toBe(4);
  });

  it('retorna pelo menos 1 para dimensões inválidas ou vazias', () => {
    expect(calcTotalPages(0, 320, 40)).toBe(1);
    expect(calcTotalPages(100, 0, 0)).toBe(1);
  });
});

describe('calcBlockPage', () => {
  it('mapeia offsetLeft para o índice da página respeitando limites', () => {
    expect(calcBlockPage(0, 360, 5)).toBe(0);
    expect(calcBlockPage(20, 360, 5)).toBe(0);
    expect(calcBlockPage(360, 360, 5)).toBe(1);
    expect(calcBlockPage(380, 360, 5)).toBe(1);
    expect(calcBlockPage(1800, 360, 5)).toBe(4);
    expect(calcBlockPage(-10, 360, 5)).toBe(0);
  });

  it('tolera arredondamento subpixel negativo na fronteira entre colunas', () => {
    expect(calcBlockPage(359, 360, 5)).toBe(1);
    expect(calcBlockPage(358, 360, 5)).toBe(1);
    expect(calcBlockPage(719, 360, 5)).toBe(2);
    expect(calcBlockPage(300, 360, 5)).toBe(0);
  });
});

describe('calcBookPercent', () => {
  const chapterChars = [500, 1000, 500];
  const totalChars = 2000;

  it('retorna 0% no início do primeiro capítulo e 100% na última página do último capítulo', () => {
    expect(calcBookPercent(0, 0, 5, chapterChars, totalChars)).toBe(0);
    expect(calcBookPercent(2, 3, 4, chapterChars, totalChars)).toBe(100);
  });

  it('calcula percentual proporcional usando chapterChars e fração do capítulo atual', () => {
    // Capítulo 0 (500 chars), página 2 de 5 => 200 / 2000 = 10%
    expect(calcBookPercent(0, 2, 5, chapterChars, totalChars)).toBe(10);
    // Início do capítulo 1 => 500 / 2000 = 25%
    expect(calcBookPercent(1, 0, 10, chapterChars, totalChars)).toBe(25);
    // Meio do capítulo 1 (pág. 5 de 10) => (500 + 500) / 2000 = 50%
    expect(calcBookPercent(1, 5, 10, chapterChars, totalChars)).toBe(50);
    // Início do capítulo 2 => 1500 / 2000 = 75%
    expect(calcBookPercent(2, 0, 4, chapterChars, totalChars)).toBe(75);
  });

  it('mantém progresso monotônico ao longo de capítulos e páginas', () => {
    let prev = -1;
    for (let ch = 0; ch < chapterChars.length; ch++) {
      for (let p = 0; p < 5; p++) {
        const pct = calcBookPercent(ch, p, 5, chapterChars, totalChars);
        expect(pct).toBeGreaterThanOrEqual(prev);
        prev = pct;
      }
    }
    expect(prev).toBe(100);
  });

  it('funciona em livros fixedLayout sem caracteres (totalChars = 0)', () => {
    expect(calcBookPercent(0, 0, 4, [0, 0], 0)).toBe(0);
    expect(calcBookPercent(1, 0, 4, [0, 0], 0)).toBe(50);
    expect(calcBookPercent(1, 3, 4, [0, 0], 0)).toBe(100);
  });

  it('lida com livro sem capítulos', () => {
    expect(calcBookPercent(0, 0, 1, [], 0)).toBe(0);
  });
});

describe('percentToTarget e fractionToPage', () => {
  const chapterChars = [500, 1000, 500];
  const totalChars = 2000;

  it('mapeia 0% para o início e 100% para o fim do último capítulo', () => {
    expect(percentToTarget(0, chapterChars, totalChars)).toEqual({ chapter: 0, fraction: 0 });
    expect(percentToTarget(100, chapterChars, totalChars)).toEqual({ chapter: 2, fraction: 1 });
  });

  it('mapeia percentuais intermediários para capítulo e fração corretos', () => {
    expect(percentToTarget(12.5, chapterChars, totalChars)).toEqual({ chapter: 0, fraction: 0.5 });
    expect(percentToTarget(25, chapterChars, totalChars)).toEqual({ chapter: 1, fraction: 0 });
    expect(percentToTarget(50, chapterChars, totalChars)).toEqual({ chapter: 1, fraction: 0.5 });
    expect(percentToTarget(75, chapterChars, totalChars)).toEqual({ chapter: 2, fraction: 0 });
  });

  it('pula capítulos vazios com 0 caracteres', () => {
    expect(percentToTarget(50, [0, 500, 500], 1000)).toEqual({ chapter: 2, fraction: 0 });
  });

  it('suporta livros com totalChars = 0', () => {
    expect(percentToTarget(50, [0, 0], 0)).toEqual({ chapter: 1, fraction: 0 });
    expect(percentToTarget(75, [0, 0], 0)).toEqual({ chapter: 1, fraction: 0.5 });
  });

  it('converte fração em índice de página válido', () => {
    expect(fractionToPage(0, 10)).toBe(0);
    expect(fractionToPage(0.5, 10)).toBe(5);
    expect(fractionToPage(0.99, 10)).toBe(9);
    expect(fractionToPage(1, 10)).toBe(9);
    expect(fractionToPage(0.5, 1)).toBe(0);
  });
});

describe('countChapterWords, estimateChapterMinutesLeft e formatRemainingTime', () => {
  it('conta palavras apenas em blocos textuais', () => {
    const blocks: Block[] = [
      { t: 'h', level: 1, text: 'Capítulo Um' },
      { t: 'p', text: 'Era uma vez um livro muito bom.' },
      { t: 'img', src: 'img1', alt: 'Descrição não conta como texto' },
      { t: 'hr' },
      { t: 'quote', text: 'Citação curta.' },
      { t: 'li', text: 'Item da lista' },
      { t: 'pre', text: 'const x = 1;' },
    ];
    // 2 + 7 + 0 + 0 + 2 + 3 + 4 = 18
    expect(countChapterWords(blocks)).toBe(18);
  });

  it('estima tempo restante a 230 palavras/min', () => {
    const tenMinWords = WORDS_PER_MINUTE * 10;
    expect(estimateChapterMinutesLeft(tenMinWords, 0, 10)).toBe(10);
    expect(estimateChapterMinutesLeft(tenMinWords, 5, 10)).toBe(5);
    expect(estimateChapterMinutesLeft(tenMinWords, 9, 10)).toBe(1);
    expect(estimateChapterMinutesLeft(20, 0, 1)).toBe(1);
    expect(estimateChapterMinutesLeft(0, 0, 5)).toBe(0);
  });

  it('formata singular e plural em português corretamente', () => {
    expect(formatRemainingTime(0)).toBe('');
    expect(formatRemainingTime(1)).toBe('1 min restante no capítulo');
    expect(formatRemainingTime(7)).toBe('7 min restantes no capítulo');
  });
});

describe('extractExcerpt', () => {
  it('extrai trecho a partir do bloco inicial pulando hr e imagens sem alt', () => {
    const blocks: Block[] = [
      { t: 'hr' },
      { t: 'img', src: 'a' },
      { t: 'p', text: '  Primeiro   parágrafo   visível da página atual.  ' },
    ];
    expect(extractExcerpt(blocks, 0, 'Capítulo 1')).toBe('Primeiro parágrafo visível da página atual.');
  });

  it('usa fallback quando não há texto', () => {
    const blocks: Block[] = [{ t: 'hr' }, { t: 'img', src: 'a' }];
    expect(extractExcerpt(blocks, 0, 'Capítulo 3')).toBe('Capítulo 3');
  });

  it('trunca textos longos com reticências sem quebrar palavra quando possível', () => {
    const blocks: Block[] = [
      {
        t: 'p',
        text: 'Este é um parágrafo suficientemente longo para ultrapassar o limite máximo de caracteres definido para o marcador.',
      },
    ];
    const excerpt = extractExcerpt(blocks, 0, 'Fallback', 50);
    expect(excerpt.length).toBeLessThanOrEqual(50);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('clampSettings', () => {
  it('mantém valores dentro das faixas permitidas', () => {
    const clamped = clampSettings({
      ...DEFAULT_SETTINGS,
      fontSize: 50,
      lineHeight: 0.8,
      margin: 100,
    });
    expect(clamped.fontSize).toBe(34);
    expect(clamped.lineHeight).toBe(1.2);
    expect(clamped.margin).toBe(48);
  });
});
