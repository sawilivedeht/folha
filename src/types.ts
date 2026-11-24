// Modelo de dados compartilhado. Contrato entre importadores, armazenamento, biblioteca e leitor.
// Não mude sem combinar: todos os módulos dependem destes tipos.

/** Trecho de texto com formatação. Renderizado com textContent (nunca HTML). */
export interface Run {
  s: string;
  b?: 1; // negrito
  i?: 1; // itálico
  sup?: 1; // sobrescrito (notas)
}

/** Bloco de conteúdo refluível. `text` é sempre o texto puro (busca e contagem); `runs`, quando houver, carrega a formatação. */
export type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string; runs?: Run[] }
  | { t: 'quote'; text: string; runs?: Run[] }
  | { t: 'li'; text: string; runs?: Run[]; ordered?: boolean }
  | { t: 'pre'; text: string }
  | { t: 'img'; src: string; alt?: string; w?: number; h?: number } // src = chave local da imagem (ver ParsedBook.images)
  | { t: 'hr' };

export interface Chapter {
  title: string;
  blocks: Block[];
}

/** Saída de qualquer importador (PDF, EPUB, TXT). Ainda sem id nem chaves de armazenamento. */
export interface ParsedBook {
  title: string;
  author?: string;
  lang?: string; // ex.: 'pt-BR'
  chapters: Chapter[];
  /** Imagens referenciadas por Block img.src (chave local -> Blob). */
  images: Map<string, Blob>;
  cover?: Blob;
  /** true quando o PDF não tem camada de texto e as páginas viraram imagens. */
  fixedLayout?: boolean;
  /** Avisos para o usuário (ex.: "PDF escaneado: páginas convertidas em imagem"). */
  warnings?: string[];
}

export type BookFormat = 'pdf' | 'epub' | 'txt';

/** Posição estável a mudanças de fonte: capítulo + índice do primeiro bloco visível. */
export interface Position {
  chapter: number;
  block: number;
}

export interface Bookmark extends Position {
  label: string; // trecho do texto no início da página
  at: number; // Date.now()
}

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  lang?: string;
  format: BookFormat;
  fileName: string;
  addedAt: number;
  lastOpenedAt?: number;
  hasCover: boolean; // capa guardada em blobs com a chave coverKey(id)
  fixedLayout?: boolean;
  /** Caracteres por capítulo; base do percentual de progresso. */
  chapterChars: number[];
  totalChars: number;
  chapterTitles: string[];
  position: Position;
  percent: number; // 0..100
  bookmarks: Bookmark[];
}

export interface BookContent {
  chapters: Chapter[];
}

export type ProgressFn = (fraction: number, label: string) => void;
