// Interações de teclado, ARIA dos cartões, toque longo e comportamento de modais na estante.
import {
  test,
  expect,
  abrirEstante,
  abrirLivro,
  importarEFechar,
  mostrarHud,
  esperarLeitor,
} from './helpers';

test.describe('Estante — teclado e toque longo', () => {
  test('botão de opções (⋯) no cartão da grade abre o menu com Enter e Espaço sem abrir o livro', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);

    const card = page.locator('.lib-grid .lib-card').first();
    const moreBtn = card.locator('.lib-more-btn');

    await moreBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await expect(page.locator('.reader')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    await moreBtn.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await expect(page.locator('.reader')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    // O próprio cartão continua abrindo o livro pelo teclado.
    await card.focus();
    await page.keyboard.press('Enter');
    await esperarLeitor(page);
  });

  test('cartão "Continuar lendo" não aninha botão em role="button" e seu menu funciona pelo teclado', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    await abrirLivro(page, 'Livro EPUB Dois');
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    const continueCard = page.locator('.lib-continue-card');
    await expect(continueCard).toBeVisible();
    await expect(continueCard).not.toHaveAttribute('role', 'button');

    const moreBtn = continueCard.locator('.lib-more-btn');
    await moreBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await expect(page.locator('.reader')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    await moreBtn.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await expect(page.locator('.reader')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    await continueCard.focus();
    await page.keyboard.press('Space');
    await esperarLeitor(page);
  });

  test('menu aberto por toque longo responde ao teclado e não vaza estado ao fechar com Escape', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);

    const card = page.locator('.lib-grid .lib-card').first();
    const box = (await card.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const p = { x: box.x + box.width / 2, y: box.y + box.height / 3 };

    // Abre o menu por toque longo sem clicar no modalLayer após soltar.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // Acionar um botão do modal imediatamente por teclado não pode ser engolido pelo descarte de toque longo.
    const detalhesBtn = page.locator('.lib-modal').getByRole('button', { name: 'Detalhes' });
    await detalhesBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-modal-title')).toHaveText('Detalhes do livro');

    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    // Fechar com Escape limpa o estado para não interferir no próximo modal aberto.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.keyboard.press('Escape');
    await expect(page.locator('.lib-modal')).toHaveCount(0);
    await cdp.detach();

    await card.locator('.lib-more-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-modal-title')).toHaveText('Livro EPUB Dois');
    const detalhes2 = page.locator('.lib-modal').getByRole('button', { name: 'Detalhes' });
    await detalhes2.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lib-modal-title')).toHaveText('Detalhes do livro');
  });

  test('sair do cartão cancela o toque longo e o cartão bloqueia menu de contexto e arraste da capa', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub', 'epub3.epub']);

    // A capa hidratada não pode ser arrastável e o cartão deve prevenir contextmenu.
    const capa = page.locator('.lib-grid .lib-cover-img').first();
    await expect(capa).toBeVisible();
    const protecao = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.lib-grid .lib-card')!;
      const img = document.querySelector<HTMLImageElement>('.lib-grid .lib-cover-img')!;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      card.dispatchEvent(ev);
      return { contextMenuBloqueado: ev.defaultPrevented, capaArrastavel: img.draggable };
    });
    expect(protecao).toEqual({ contextMenuBloqueado: true, capaArrastavel: false });

    const card1 = page.locator('.lib-grid .lib-card').nth(0);
    const card2 = page.locator('.lib-grid .lib-card').nth(1);
    const titulo1 = ((await card1.locator('.lib-card-title').textContent()) ?? '').trim();
    const titulo2 = ((await card2.locator('.lib-card-title').textContent()) ?? '').trim();

    // Registra todo modal que abrir durante o teste para garantir que o timer do card1 foi cancelado em pointerleave.
    await page.evaluate(() => {
      const abertos: string[] = [];
      (window as unknown as { __modaisAbertos: string[] }).__modaisAbertos = abertos;
      const obs = new MutationObserver(() => {
        const t = document.querySelector('.lib-modal-title')?.textContent?.trim();
        if (t && abertos[abertos.length - 1] !== t) abertos.push(t);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });

    const box1 = (await card1.boundingBox())!;
    const box2 = (await card2.boundingBox())!;

    // Pressiona perto da borda do card1 e sai dele movendo apenas 5px (< 10px de tolerância do pointermove).
    await page.mouse.move(box1.x + 2, box1.y + 12);
    await page.mouse.down();
    await page.mouse.move(box1.x - 3, box1.y + 12);
    await page.mouse.up();

    // Agora faz toque longo no card2 e espera o menu dele abrir (tempo suficiente para o timer do card1 ter disparado).
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 3);
    await page.mouse.down();
    await expect(page.locator('.lib-modal-title')).toHaveText(titulo2);
    await page.mouse.up();

    const abertos = await page.evaluate(() => (window as unknown as { __modaisAbertos: string[] }).__modaisAbertos);
    expect(abertos).toEqual([titulo2]);
    expect(abertos).not.toContain(titulo1);
  });
});
