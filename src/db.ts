// Armazenamento local em IndexedDB. Stores: meta (BookMeta), content (BookContent por id),
// blobs (imagens e capas), kv (configurações).
import type { BookContent, BookMeta } from './types';

const DB_NAME = 'folha';
const DB_VERSION = 1;
const STORES = ['meta', 'content', 'blobs', 'kv'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Pede armazenamento persistente para o Android não apagar a biblioteca sob pressão de espaço.
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const coverKey = (bookId: string) => `${bookId}/cover`;
export const imageKey = (bookId: string, localKey: string) => `${bookId}/img/${localKey}`;

export async function listBooks(): Promise<BookMeta[]> {
  const all = (await wrap((await store('meta')).getAll())) as BookMeta[];
  return all.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
}

export async function getMeta(id: string): Promise<BookMeta | undefined> {
  return wrap((await store('meta')).get(id));
}

export async function putMeta(meta: BookMeta): Promise<void> {
  await wrap((await store('meta', 'readwrite')).put(meta, meta.id));
}

export async function getContent(id: string): Promise<BookContent | undefined> {
  return wrap((await store('content')).get(id));
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return wrap((await store('blobs')).get(key));
}

/** Grava livro completo numa transação só: meta, conteúdo e blobs. */
export async function saveBook(meta: BookMeta, content: BookContent, blobs: Map<string, Blob>): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'content', 'blobs'], 'readwrite');
    tx.objectStore('meta').put(meta, meta.id);
    tx.objectStore('content').put(content, meta.id);
    const b = tx.objectStore('blobs');
    for (const [k, v] of blobs) b.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteBook(id: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'content', 'blobs'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('content').delete(id);
    tx.objectStore('blobs').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return wrap((await store('kv')).get(key));
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await wrap((await store('kv', 'readwrite')).put(value, key));
}
