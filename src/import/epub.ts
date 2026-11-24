// STUB: substituído pelo worker do EPUB/TXT.
import type { ParsedBook, ProgressFn } from '../types';

export async function parseEpub(_data: ArrayBuffer, _fileName: string, _onProgress: ProgressFn): Promise<ParsedBook> {
  throw new Error('não implementado');
}
