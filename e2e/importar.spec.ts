import { test, expect, abrirEstante, importar, fecharModal, arquivo } from './helpers';

test.describe('Importação', () => {
  const casos: Array<[string, string, string | RegExp]> = [
    ['longo.txt', 'O Grande Livro de Teste', ''],
    ['gigante.txt', 'Texto com Palavras Gigantes', ''],
    ['epub3.epub', 'Livro EPUB Três', 'Autora Exemplar'],
    ['epub2.epub', 'Livro EPUB Dois', 'Zeca Antigo'],
    ['texto.pdf', 'PDF de Texto', 'Pedro Documento'],
  ];
  for (const [nome, titulo, autor] of casos) {
    test(`importa ${nome} e mostra título/autor na estante`, async ({ page }) => {
      await abrirEstante(page);
      await importar(page, [nome]);
      await fecharModal(page);
      const card = page.locator('.lib-card', { hasText: titulo });
      await expect(card).toHaveCount(1);
      if (autor) await expect(card).toContainText(autor);
    });
  }

  test('PDF escaneado mostra aviso', async ({ page }) => {
    await abrirEstante(page);
    await importar(page, ['escaneado.pdf']);
    await expect(page.locator('.lib-warnings')).toContainText('escaneado');
    await fecharModal(page);
    await expect(page.locator('.lib-card')).toHaveCount(1);
  });

  test('arquivos inválidos mostram erro legível e a estante continua usável', async ({ page }) => {
    await abrirEstante(page);
    await importar(page, ['epub2.epub']);
    await fecharModal(page);
    for (const nome of ['invalido.docx', 'corrompido.pdf']) {
      await importar(page, [nome]);
      const erro = page.locator('.lib-modal-error');
      await expect(erro).toContainText(nome);
      await expect(erro).not.toContainText(/undefined|\[object|TypeError/);
      await fecharModal(page);
    }
    await expect(page.locator('.lib-card')).toHaveCount(1);
    await importar(page, ['epub3.epub']);
    await fecharModal(page);
    await expect(page.locator('.lib-card')).toHaveCount(2);
  });
});
