import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('devolve os padrões para valores que não são objetos', () => {
    for (const lixo of [undefined, null, 'texto', 42, true, [1, 2, 3]]) {
      expect(sanitizeSettings(lixo)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('aproveita os campos válidos e descarta os corrompidos', () => {
    const r = sanitizeSettings({ fontSize: 24, lineHeight: 'x', margin: NaN, font: 'inexistente', justify: 'sim', hyphenate: false, theme: 'neon' });
    expect(r).toEqual({ ...DEFAULT_SETTINGS, fontSize: 24, hyphenate: false });
  });

  it('aceita temas e fontes conhecidos', () => {
    expect(sanitizeSettings({ theme: 'black', font: 'dyslexic' })).toMatchObject({ theme: 'black', font: 'dyslexic' });
  });

  it('não é enganada por chaves herdadas do protótipo', () => {
    expect(sanitizeSettings({ font: 'toString' }).font).toBe(DEFAULT_SETTINGS.font);
    expect(sanitizeSettings({ font: '__proto__' }).font).toBe(DEFAULT_SETTINGS.font);
  });

  it('rejeita infinitos (o leitor aplica os limites depois)', () => {
    expect(sanitizeSettings({ fontSize: Infinity }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });
});
