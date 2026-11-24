// Preferências de leitura. Persistidas em kv('settings'); aplicadas como variáveis CSS no leitor.
import { kvGet, kvSet } from './db';

export type Theme = 'light' | 'sepia' | 'dark' | 'black';
export type FontFamily = 'serif' | 'sans' | 'dyslexic';

export interface ReaderSettings {
  fontSize: number; // px, 14..34
  lineHeight: number; // 1.2..2.0
  margin: number; // px laterais, 8..48
  font: FontFamily;
  justify: boolean;
  hyphenate: boolean;
  theme: Theme;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.55,
  margin: 20,
  font: 'serif',
  justify: true,
  hyphenate: true,
  theme: 'light',
};

export const FONT_STACKS: Record<FontFamily, string> = {
  serif: '"Noto Serif", "Droid Serif", Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Roboto", "Noto Sans", "Segoe UI", sans-serif',
  dyslexic: '"Atkinson Hyperlegible", "Verdana", "Noto Sans", sans-serif',
};

let cache: ReaderSettings | null = null;

export async function loadSettings(): Promise<ReaderSettings> {
  if (!cache) cache = { ...DEFAULT_SETTINGS, ...((await kvGet<Partial<ReaderSettings>>('settings')) ?? {}) };
  return cache;
}

export async function saveSettings(s: ReaderSettings): Promise<void> {
  cache = s;
  await kvSet('settings', s);
}

/** Aplica o tema no documento inteiro (biblioteca e leitor compartilham). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#f7f3ea');
}
