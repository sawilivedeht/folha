// STUB: substituído pelo worker do PDF.
import type { ParsedBook, ProgressFn } from '../types';

export async function parsePdf(_data: ArrayBuffer, _fileName: string, _onProgress: ProgressFn): Promise<ParsedBook> {
  throw new Error('não implementado');
}
