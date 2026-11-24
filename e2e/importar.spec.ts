import { test, expect, abrirEstante, importar, fecharModal, esperarCapaValida } from './helpers';

test.describe('Importação', () => {
  const casos: Array<[string, string, string | RegExp, boolean]> = [
    ['longo.txt', 'O Grande Livro de Teste', '', false],
    ['gigante.txt', 'Texto com Palavras Gigantes', '', false],
    ['epub3.epub', 'Livro EPUB Três', 'Autora Exemplar', true],
    ['epub2.epub', 'Livro EPUB Dois', 'Zeca Antigo', false],
    ['texto.pdf', 'PDF de Texto', 'Pedro Documento', true],
  ];
  for (const [nome, titulo, autor, temCapa] of casos) {
    test(`importa ${nome} e mostra título/autor na estante`, async ({ page }) => {
      await abrirEstante(page);
      await importar(page, [nome]);
      await fecharModal(page);
      const card = page.locator('.lib-card', { hasText: titulo });
      await expect(card).toHaveCount(1);
      if (autor) await expect(card).toContainText(autor);
      if (temCapa) await esperarCapaValida(page, titulo);
    });
  }

  test('PDF escaneado mostra aviso', async ({ page }) => {
    await abrirEstante(page);
    await importar(page, ['escaneado.pdf']);
    await expect(page.locator('.lib-warnings')).toContainText('escaneado');
    await fecharModal(page);
    await expect(page.locator('.lib-card')).toHaveCount(1);
    await esperarCapaValida(page, 'PDF Escaneado');
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
