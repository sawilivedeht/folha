// STUB: substituído pelo worker do leitor.
export function mountReader(root: HTMLElement, bookId: string): () => void {
  root.textContent = `Leitor: ${bookId}`;
  return () => {};
}
