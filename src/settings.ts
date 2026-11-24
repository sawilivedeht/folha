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

const THEMES: readonly Theme[] = ['light', 'sepia', 'dark', 'black'];

/** Aproveita só os campos com tipo válido; o que estiver corrompido volta ao padrão. */
export function sanitizeSettings(raw: unknown): ReaderSettings {
  const out: ReaderSettings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (num(r.fontSize)) out.fontSize = r.fontSize;
  if (num(r.lineHeight)) out.lineHeight = r.lineHeight;
  if (num(r.margin)) out.margin = r.margin;
  if (typeof r.font === 'string' && Object.hasOwn(FONT_STACKS, r.font)) out.font = r.font as FontFamily;
  if (typeof r.justify === 'boolean') out.justify = r.justify;
  if (typeof r.hyphenate === 'boolean') out.hyphenate = r.hyphenate;
  if (typeof r.theme === 'string' && (THEMES as readonly string[]).includes(r.theme)) out.theme = r.theme as Theme;
  return out;
}

export async function loadSettings(): Promise<ReaderSettings> {
  if (!cache) {
    try {
      cache = sanitizeSettings(await kvGet<unknown>('settings'));
    } catch {
      // Armazenamento indisponível: lê com os padrões, sem guardar no cache (a próxima chamada tenta de novo).
      return { ...DEFAULT_SETTINGS };
    }
  }
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
