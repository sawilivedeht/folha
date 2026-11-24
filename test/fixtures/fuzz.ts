// Utilitários de fuzzing determinístico (sem dependências): PRNG com semente fixa, mutações de
// bytes, verificação do contrato de `ParsedBook` e das mensagens de erro para o usuário.
import { expect } from 'vitest';
import { buildMeta } from '../../src/import/index';
import type { Block, ParsedBook } from '../../src/types';

/** Número de casos por formato: o padrão em CI; `FUZZ_RUNS=2000` para uma rodada longa. */
export function fuzzRuns(padrao = 150): number {
  const n = Number(process.env.FUZZ_RUNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : padrao;
}

/** Semente base; `FUZZ_SEED` permite explorar outras regiões sem mudar o código. */
export function fuzzSeed(): number {
  const n = Number(process.env.FUZZ_SEED);
  return Number.isFinite(n) ? n >>> 0 : 20260101;
}

export interface Rng {
  next(): number;
  int(max: number): number;
  range(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

/** mulberry32: PRNG de 32 bits, determinístico. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    range: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

/** Aplica de 1 a `maxOps` mutações (trocar, inserir, apagar, truncar, duplicar trecho) a uma cópia. */
export function mutateBytes(src: Uint8Array, rng: Rng, maxOps = 6): Uint8Array<ArrayBuffer> {
  let out = Array.from(src);
  const ops = rng.range(1, maxOps);
  for (let k = 0; k < ops; k++) {
    if (out.length === 0) {
      out.push(rng.int(256));
      continue;
    }
    const pos = rng.int(out.length);
    switch (rng.int(6)) {
      case 0:
        out[pos] = rng.int(256);
        break;
      case 1:
        out.splice(pos, 0, rng.int(256));
        break;
      case 2:
        out.splice(pos, rng.range(1, 8));
        break;
      case 3:
        out = out.slice(0, pos);
        break;
      case 4: {
        const len = rng.range(1, 64);
        out.splice(pos, 0, ...out.slice(pos, pos + len));
        break;
      }
      default:
        out[pos] = out[pos] ^ (1 << rng.int(8));
    }
  }
  return Uint8Array.from(out);
}

/** Mutações de texto (para XHTML/OPF/container): inserir lixo, apagar, truncar, duplicar trecho. */
export function mutateText(src: string, rng: Rng, maxOps = 5): string {
  let s = src;
  const lixo = ['<', '>', '</', '/>', '&', '&#', '&#x', '"', "'", '\u0000', '￿', '<![CDATA[', ']]>', '<!--', '-->', '<?', '\ud800'];
  const ops = rng.range(1, maxOps);
  for (let k = 0; k < ops; k++) {
    if (s.length === 0) {
      s = rng.pick(lixo);
      continue;
    }
    const pos = rng.int(s.length);
    switch (rng.int(5)) {
      case 0:
        s = s.slice(0, pos) + rng.pick(lixo) + s.slice(pos);
        break;
      case 1:
        s = s.slice(0, pos) + s.slice(pos + rng.range(1, 30));
        break;
      case 2:
        s = s.slice(0, pos);
        break;
      case 3: {
        const len = rng.range(1, 80);
        s = s.slice(0, pos) + s.slice(pos, pos + len) + s.slice(pos);
        break;
      }
      default:
        s = s.slice(0, pos) + String.fromCharCode(rng.int(0xffff)) + s.slice(pos + 1);
    }
  }
  return s;
}

const TAGS = ['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'b', 'i', 'em', 'strong', 'sup', 'br', 'hr', 'img', 'a', 'table', 'tr', 'td', 'blockquote', 'pre', 'code', 'section', 'svg', 'ruby', 'style'];
const PALAVRAS = ['informação', 'capítulo', 'leitura', 'São Paulo', 'ação', 'não', 'texto', 'a', 'de', '😀', 'ñ', 'ǅ', '​', '­', '&amp;', '&nbsp;', '&eacute;', '&#233;', '&#xZZ;', '&bogus;'];

/** XHTML aleatório (por vezes bem formado, por vezes não): tags embaralhadas, aninhamento absurdo. */
export function randomXhtml(rng: Rng): string {
  const parts: string[] = [];
  const n = rng.range(0, 60);
  const open: string[] = [];
  for (let i = 0; i < n; i++) {
    switch (rng.int(5)) {
      case 0: {
        const t = rng.pick(TAGS);
        open.push(t);
        const attrs = rng.chance(0.3) ? ` src="${rng.pick(['a.png', '../x/b.png', 'nao-existe.png', 'data:image/png;base64,AAAA', '%E0%A4%A', ''])}" alt="${rng.pick(PALAVRAS)}"` : '';
        parts.push(`<${t}${attrs}>`);
        break;
      }
      case 1:
        if (open.length > 0 && rng.chance(0.7)) parts.push(`</${open.pop()}>`);
        else parts.push(`</${rng.pick(TAGS)}>`);
        break;
      case 2:
        parts.push(rng.pick(PALAVRAS));
        break;
      case 3:
        parts.push(`<${rng.pick(TAGS)}/>`);
        break;
      default:
        parts.push(' ' + rng.pick(PALAVRAS) + ' ');
    }
  }
  const corpo = parts.join('');
  switch (rng.int(4)) {
    case 0:
      return corpo;
    case 1:
      return `<html><body>${corpo}</body></html>`;
    case 2:
      return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${corpo}</body></html>`;
    default:
      return `<!DOCTYPE html><html><head><title>x</title></head><body>${corpo}`;
  }
}

/** Texto binário/misto: bytes aleatórios, UTF-8 e windows-1252 misturados, BOMs soltos. */
export function randomTxtBytes(rng: Rng): Uint8Array {
  const chunks: number[] = [];
  const enc = new TextEncoder();
  const total = rng.range(0, 40);
  if (rng.chance(0.2)) chunks.push(...rng.pick([[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff]]));
  for (let i = 0; i < total; i++) {
    switch (rng.int(6)) {
      case 0:
        for (let j = rng.range(1, 200); j > 0; j--) chunks.push(rng.int(256));
        break;
      case 1:
        chunks.push(...enc.encode(rng.pick(PALAVRAS) + ' '));
        break;
      case 2:
        chunks.push(0xe9, 0xe7, 0xe3, 0x20); // "éçã " em windows-1252
        break;
      case 3:
        chunks.push(...enc.encode(rng.pick(['\n', '\n\n', '\r\n', '\r', '\n\n\n'])));
        break;
      case 4:
        chunks.push(...enc.encode(rng.pick(['CAPÍTULO 1', 'Capítulo II', 'PARTE ÚNICA', 'Prólogo', 'IV', 'FIM']) + '\n'));
        break;
      default:
        chunks.push(...enc.encode('Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(rng.range(1, 6))));
    }
  }
  return Uint8Array.from(chunks);
}

/** Erros esperados pelo usuário: `Error` genérico (não TypeError etc.) com mensagem em português. */
export function expectErroAmigavel(err: unknown, contexto: string): void {
  expect(err, `${contexto}: lançou algo que não é Error`).toBeInstanceOf(Error);
  const e = err as Error;
  expect(e.constructor, `${contexto}: classe ${e.constructor.name} (${e.message})`).toBe(Error);
  const msg = e.message;
  expect(msg.length, `${contexto}: mensagem vazia`).toBeGreaterThan(5);
  // Vazamento de mensagens internas de fflate/pdf.js/DOM.
  expect(msg, `${contexto}: mensagem interna vazou: ${msg}`).not.toMatch(
    /unexpected EOF|invalid zip data|invalid block type|invalid distance|unknown compression|undefined|\bnull\b|NaN|\[object|Cannot read|is not a function|Invalid PDF structure|Bad end offset|XRef|FormatError|UnknownErrorException|^Error:/i,
  );
  expect(msg, `${contexto}: mensagem não parece português: ${msg}`).toMatch(
    /[áéíóúâêôãõç]|\b(?:não|arquivo|inválido|inválida|corrompid[oa]|PDF|EPUB|texto|livro|capítulo)\b/i,
  );
}

function blockChars(b: Block): number {
  return b.t === 'img' || b.t === 'hr' ? 0 : b.text.length;
}

/** Confere o contrato de `ParsedBook` e a coerência de `buildMeta`. */
export function checarLivro(parsed: ParsedBook, contexto: string, opts: { permitirVazio?: boolean } = {}): void {
  expect(typeof parsed.title, `${contexto}: título`).toBe('string');
  expect(Array.isArray(parsed.chapters), `${contexto}: capítulos`).toBe(true);
  if (!opts.permitirVazio) expect(parsed.chapters.length, `${contexto}: sem capítulos`).toBeGreaterThan(0);
  for (const [i, ch] of parsed.chapters.entries()) {
    expect(typeof ch.title, `${contexto}: título do capítulo ${i}`).toBe('string');
    expect(ch.blocks.length, `${contexto}: capítulo ${i} vazio`).toBeGreaterThan(0);
    for (const b of ch.blocks) {
      if (b.t === 'img') {
        expect(parsed.images.has(b.src), `${contexto}: img.src "${b.src}" ausente em images`).toBe(true);
      } else if (b.t !== 'hr') {
        expect(typeof b.text, `${contexto}: bloco ${b.t} sem texto`).toBe('string');
      }
    }
  }
  const meta = buildMeta(parsed, { fileName: 'fuzz.bin', format: 'txt' }, 'id', 0);
  expect(meta.chapterChars).toHaveLength(parsed.chapters.length);
  expect(meta.chapterTitles).toHaveLength(parsed.chapters.length);
  expect(meta.chapterChars).toEqual(parsed.chapters.map((c) => c.blocks.reduce((n, b) => n + blockChars(b), 0)));
  expect(meta.totalChars).toBe(meta.chapterChars.reduce((a, b) => a + b, 0));
  expect(meta.title.length, `${contexto}: título vazio`).toBeGreaterThan(0);
}

/** Executa `fn` com limite de tempo; estoura com mensagem clara em vez de travar o teste. */
export async function comLimite<T>(fn: () => Promise<T> | T, ms: number, contexto: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`TRAVOU (> ${ms} ms): ${contexto}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Resultado {
  ok: boolean;
  erro?: unknown;
  /** Conversão sem conteúdo aproveitável (o importador mostra "Não encontrei texto"). */
  vazio?: boolean;
}

/** Roda uma conversão e valida o resultado ou o erro. Devolve se foi livro ou erro. */
export async function verificarConversao(
  conv: () => Promise<ParsedBook> | ParsedBook,
  contexto: string,
  opts: { ms?: number; permitirVazio?: boolean } = {},
): Promise<Resultado> {
  let parsed: ParsedBook;
  try {
    parsed = await comLimite(conv, opts.ms ?? 8000, contexto);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('TRAVOU')) throw err;
    expectErroAmigavel(err, contexto);
    return { ok: false, erro: err };
  }
  // Mesma regra de `importFileWithWarnings`: sem texto nem imagens, o importador recusa o arquivo.
  const temTexto = parsed.chapters.some((ch) => ch.blocks.some((b) => b.t !== 'img' && b.t !== 'hr' && b.text.trim().length > 0));
  const temImagem = parsed.chapters.some((ch) => ch.blocks.some((b) => b.t === 'img'));
  if (parsed.chapters.length === 0) {
    expect(parsed.images.size, `${contexto}: imagens órfãs sem nenhum capítulo`).toBe(0);
    return { ok: false, vazio: true };
  }
  checarLivro(parsed, contexto, { permitirVazio: opts.permitirVazio });
  if (!temTexto && !temImagem) return { ok: false, vazio: true };
  return { ok: true };
}

/**
 * O pdf.js no Node roda o "worker" na mesma thread; ao ler um PDF danificado ele deixa uma Promise
 * interna rejeitada sem tratamento (FormatError, XRefParseException...). No navegador isso fica
 * confinado ao Web Worker. Durante o fuzzing, essas rejeições são contadas e as demais viram falha.
 * Devolve `restaurar()`, que reinstala os listeners originais e lança se algo estranho apareceu.
 */
export function isolarRejeicoesDoPdfjs(): { restaurar: () => { pdfjs: number } } {
  const originais = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  let pdfjs = 0;
  const outras: unknown[] = [];
  // Exceções próprias do pdf.js (ParserEOFException, XRefParseException, FormatError...).
  const nomes = /^(?:FormatError|\w+Exception)$/;
  process.on('unhandledRejection', (reason) => {
    const nome = reason && typeof reason === 'object' ? String((reason as { name?: unknown }).name ?? '') : '';
    if (nomes.test(nome)) pdfjs++;
    else outras.push(reason);
  });
  return {
    restaurar: () => {
      process.removeAllListeners('unhandledRejection');
      for (const l of originais) process.on('unhandledRejection', l);
      if (outras.length > 0) throw new Error(`Rejeições não tratadas inesperadas: ${outras.map(String).join('; ')}`);
      return { pdfjs };
    },
  };
}
