// STUB: substituído pelo worker da biblioteca. Contrato:
// importFile(file, onProgress) detecta o formato pela extensão/assinatura, chama o importador,
// grava com saveBook (imagens em imageKey(id, chave), capa em coverKey(id)) e devolve o id.
import type { ProgressFn } from '../types';

export async function importFile(_file: File, _onProgress: ProgressFn): Promise<string> {
  throw new Error('não implementado');
}
