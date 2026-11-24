import { describe, expect, it } from 'vitest';
import { checarLivro, comLimite, fuzzRuns, fuzzSeed, mulberry32, mutateBytes, randomTxtBytes } from '../../test/fixtures/fuzz';
import { decodeText, parseTxt } from './txt';

const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

const SEMENTE_VALIDA = new TextEncoder().encode(
  'MEU LIVRO\nAutora\n\nCAPÍTULO 1\n\nPrimeiro parágrafo com acentuação: ação, coração, não.\n\nSegundo parágrafo.\n\nCAPÍTULO 2\n\nOutro texto qualquer.\n',
);

describe('TXT: fuzzing com semente fixa', () => {
  it('bytes aleatórios e mutações nunca travam e respeitam o contrato', async () => {
    const rng = mulberry32(fuzzSeed() ^ 0x7478);
    const n = fuzzRuns(300);
    let livros = 0;
    for (let i = 0; i < n; i++) {
      const bytes = rng.chance(0.5) ? randomTxtBytes(rng) : mutateBytes(SEMENTE_VALIDA, rng);
      const ctx = `txt#${i}`;
      const parsed = await comLimite(() => parseTxt(decodeText(toBuf(bytes)), 'fuzz.txt'), 5000, ctx);
      // TXT vazio/só espaços gera 0 capítulos (index.ts recusa depois); o resto precisa ser válido.
      checarLivro(parsed, ctx, { permitirVazio: true });
      if (parsed.chapters.length > 0) livros++;
    }
    expect(livros).toBeGreaterThan(n / 4);
  });

  it('UTF-8 válido é decodificado sem perdas', () => {
    const s = 'Ação, coração, 😀 e ñ.\n';
    expect(decodeText(toBuf(new TextEncoder().encode(s)))).toBe(s);
  });
});
