import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  estado,
  mostrarHud,
  esconderHud,
} from './helpers';
import type { Page } from '@playwright/test';

async function abrirLivroTeste(
  page: Page,
  arquivo = 'epub3.epub',
  titulo = 'Livro EPUB Três',
): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await abrirEstante(page);
  await importarEFechar(page, [arquivo]);
  await abrirLivro(page, titulo);
}

async function irParaCapitulo1Longo(page: Page): Promise<void> {
  await abrirLivroTeste(page, 'longo.txt', 'O Grande Livro de Teste');
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await page.locator('.reader-toc-item', { hasText: 'Capítulo 1' }).click();
  await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);
  await expect.poll(async () => (await estado(page)).total).toBeGreaterThan(5);
}

async function translateXColunas(page: Page): Promise<number> {
  return page.evaluate(() => {
    const columns = document.querySelector<HTMLElement>('.reader-columns');
    if (!columns) return NaN;
    const t = getComputedStyle(columns).transform;
    if (!t || t === 'none') return 0;
    return new DOMMatrixReadOnly(t).m41;
  });
}

test.describe('Leitor — teclado, foco e acessibilidade', () => {
  test('HUD fechado fica inerte ao Tab e pode ser aberto por botão acessível ou atalho m', async ({ page }) => {
    await abrirLivroTeste(page);
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);

    const estadoBarrasFechadas = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>('.reader-topbar')!;
      const bottom = document.querySelector<HTMLElement>('.reader-bottombar')!;
      return {
        topInert: top.inert,
        bottomInert: bottom.inert,
        topAriaHidden: top.getAttribute('aria-hidden'),
        bottomAriaHidden: bottom.getAttribute('aria-hidden'),
      };
    });
    expect(estadoBarrasFechadas).toEqual({
      topInert: true,
      bottomInert: true,
      topAriaHidden: 'true',
      bottomAriaHidden: 'true',
    });

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      const dentroDoHud = await page.evaluate(() => {
        const el = document.activeElement;
        return Boolean(el && (el.closest('.reader-topbar') || el.closest('.reader-bottombar')));
      });
      expect(dentroDoHud, `Tab ${i + 1} não deve focar controles do HUD fechado`).toBe(false);
    }

    // Abre o HUD pelo botão acessível revelado ao receber foco.
    const revealBtn = page.getByRole('button', { name: 'Mostrar controles' });
    await revealBtn.focus();
    const caixaReveal = await revealBtn.boundingBox();
    expect(caixaReveal?.width ?? 0).toBeGreaterThan(40);
    expect(caixaReveal?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');

    await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
    const focoNoTopbar = await page.evaluate(() =>
      Boolean(document.querySelector('.reader-topbar')?.contains(document.activeElement)),
    );
    expect(focoNoTopbar).toBe(true);

    // Fecha via Escape e testa alternância direta pelo atalho m.
    await page.keyboard.press('Escape');
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);

    await page.keyboard.press('m');
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
    await page.keyboard.press('m');
    await expect(page.locator('.reader.is-hud-open')).toHaveCount(0);
  });

  test('slider mantém foco no teclado e Espaço ativa botões do HUD sem virar página', async ({ page }) => {
    await irParaCapitulo1Longo(page);
    await mostrarHud(page);

    const slider = page.getByRole('slider', { name: 'Progresso do livro' });
    await slider.focus();
    const valorInicial = Number(await slider.inputValue());

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight');
      await expect(slider).toBeFocused();
      await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
    }
    expect(Number(await slider.inputValue())).toBeGreaterThan(valorInicial);

    // Foca um botão da barra superior e ativa com Espaço: não deve fechar o HUD nem virar página.
    const bmBtn = page.getByRole('button', { name: 'Marcar esta página' });
    await bmBtn.focus();
    const paginaAntes = (await estado(page)).pagina;
    await page.keyboard.press('Space');

    await expect(page.locator('.reader.is-hud-open')).toHaveCount(1);
    expect((await estado(page)).pagina).toBe(paginaAntes);
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('painéis modais aprisionam e restauram foco, vinculam abas ARIA e preservam foco ao excluir marcador', async ({
    page,
  }) => {
    await irParaCapitulo1Longo(page);

    // Cria dois marcadores em páginas diferentes para testar foco no vizinho e na lista vazia.
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await esconderHud(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();

    const tocBtn = page.getByRole('button', { name: 'Sumário e marcadores' });
    await tocBtn.focus();
    await page.keyboard.press('Enter');

    const drawer = page.locator('.reader-drawer');
    await expect(drawer).toBeVisible();

    const fundoInerte = await page.evaluate(() => ({
      viewport: document.querySelector<HTMLElement>('.reader-viewport')!.inert,
      topbar: document.querySelector<HTMLElement>('.reader-topbar')!.inert,
      bottombar: document.querySelector<HTMLElement>('.reader-bottombar')!.inert,
      focoNoDrawer: Boolean(document.querySelector('.reader-drawer')?.contains(document.activeElement)),
    }));
    expect(fundoInerte).toEqual({
      viewport: true,
      topbar: true,
      bottombar: true,
      focoNoDrawer: true,
    });

    // Associações ARIA entre tabs e tabpanels + navegação por setas horizontais.
    const tabSumario = drawer.getByRole('tab', { name: 'Sumário' });
    const tabMarcadores = drawer.getByRole('tab', { name: 'Marcadores' });
    const vinculos = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('.reader-drawer [role="tab"]'));
      const panels = Array.from(document.querySelectorAll<HTMLElement>('.reader-drawer [role="tabpanel"]'));
      return {
        tocControls: tabs[0]?.getAttribute('aria-controls'),
        tocPanelId: panels[0]?.id,
        tocLabelledBy: panels[0]?.getAttribute('aria-labelledby'),
        tocTabId: tabs[0]?.id,
        bmControls: tabs[1]?.getAttribute('aria-controls'),
        bmPanelId: panels[1]?.id,
        bmLabelledBy: panels[1]?.getAttribute('aria-labelledby'),
        bmTabId: tabs[1]?.id,
      };
    });
    expect(vinculos.tocControls).toBeTruthy();
    expect(vinculos.tocControls).toBe(vinculos.tocPanelId);
    expect(vinculos.tocLabelledBy).toBe(vinculos.tocTabId);
    expect(vinculos.bmControls).toBeTruthy();
    expect(vinculos.bmControls).toBe(vinculos.bmPanelId);
    expect(vinculos.bmLabelledBy).toBe(vinculos.bmTabId);

    await expect(tabSumario).toBeFocused();
    // Shift+Tab no primeiro controle do diálogo deve circular para o último dentro do diálogo.
    await page.keyboard.press('Shift+Tab');
    const focoCircularDrawer = await page.evaluate(() =>
      Boolean(document.querySelector('.reader-drawer')?.contains(document.activeElement)),
    );
    expect(focoCircularDrawer).toBe(true);
    // Tab a partir do último volta para o primeiro controle do diálogo.
    await page.keyboard.press('Tab');
    await expect(tabSumario).toBeFocused();

    // Seta direita alterna para a aba Marcadores e move o foco para ela.
    await page.keyboard.press('ArrowRight');
    await expect(tabMarcadores).toBeFocused();
    await expect(tabMarcadores).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.locator('.reader-bm-item')).toHaveCount(2);

    // Excluir o primeiro marcador pelo teclado mantém o foco dentro do diálogo (no marcador vizinho).
    const primeiroExcluir = drawer.getByRole('button', { name: 'Remover marcador' }).first();
    await primeiroExcluir.focus();
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.reader-bm-item')).toHaveCount(1);
    const focoAposPrimeiroDelete = await page.evaluate(() => {
      const el = document.activeElement;
      return Boolean(el && document.querySelector('.reader-drawer')?.contains(el) && el.classList.contains('reader-bm-del'));
    });
    expect(focoAposPrimeiroDelete).toBe(true);

    // Excluir o último marcador devolve o foco à aba Marcadores dentro do diálogo (nunca ao body).
    await page.keyboard.press('Enter');
    await expect(drawer.locator('.reader-bm-item')).toHaveCount(0);
    await expect(tabMarcadores).toBeFocused();

    // Escape fecha o sumário e restaura o foco ao botão que o abriu.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(tocBtn).toBeFocused();

    // Painel "Aa": abre, move foco, aprisiona Tab/Shift+Tab e restaura foco ao fechar.
    const aaBtn = page.getByRole('button', { name: 'Configurações de leitura' });
    await aaBtn.focus();
    await page.keyboard.press('Enter');

    const sheet = page.locator('.reader-aa-sheet');
    await expect(sheet).toBeVisible();
    const focoNoSheet = await page.evaluate(() =>
      Boolean(document.querySelector('.reader-aa-sheet')?.contains(document.activeElement)),
    );
    expect(focoNoSheet).toBe(true);

    await page.keyboard.press('Shift+Tab');
    const focoCircularSheet = await page.evaluate(() =>
      Boolean(document.querySelector('.reader-aa-sheet')?.contains(document.activeElement)),
    );
    expect(focoCircularSheet).toBe(true);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(aaBtn).toBeFocused();
  });

  test('slider anuncia progresso legível em aria-valuetext e painel Aa expõe live regions e grupos', async ({
    page,
  }) => {
    await abrirLivroTeste(page);
    await mostrarHud(page);

    const slider = page.getByRole('slider', { name: 'Progresso do livro' });
    await expect(slider).toHaveAttribute('aria-valuetext', /A casa na colina.*0%/);

    // Atualiza o valor durante o arrasto (input) e verifica que aria-valuetext reflete o percentual, não 0..1000.
    await slider.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '500';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(slider).toHaveAttribute('aria-valuetext', /50%/);

    await page.getByRole('button', { name: 'Configurações de leitura' }).click();
    const sheet = page.locator('.reader-aa-sheet');
    await expect(sheet).toBeVisible();

    const liveVals = await sheet.locator('.reader-step-val').evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-live')),
    );
    expect(liveVals).toEqual(['polite', 'polite', 'polite']);

    const grupoFonte = sheet.getByRole('group', { name: 'Fonte' });
    await expect(grupoFonte.getByRole('button', { name: 'Serifa', exact: true })).toBeVisible();
    await expect(grupoFonte.getByRole('button', { name: 'Sem serifa', exact: true })).toBeVisible();

    const grupoTema = sheet.getByRole('group', { name: 'Tema' });
    await expect(grupoTema.getByRole('button', { name: 'Claro', exact: true })).toBeVisible();
    await expect(grupoTema.getByRole('button', { name: 'Escuro', exact: true })).toBeVisible();
  });

  test('lostpointercapture e pointermove sem botão soltam o arrasto horizontal sem travar a página', async ({
    page,
  }) => {
    await irParaCapitulo1Longo(page);
    expect((await estado(page)).pagina).toBe(1);
    expect(await translateXColunas(page)).toBe(0);

    // 1) Perda de captura (lostpointercapture) sem pointerup/pointercancel.
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      vp.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 7,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          isPrimary: true,
          clientX: 240,
          clientY: 200,
          bubbles: true,
        }),
      );
      vp.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 7,
          pointerType: 'mouse',
          buttons: 1,
          isPrimary: true,
          clientX: 160,
          clientY: 200,
          bubbles: true,
        }),
      );
    });
    expect(await translateXColunas(page)).toBeLessThan(-20);

    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      vp.dispatchEvent(
        new PointerEvent('lostpointercapture', {
          pointerId: 7,
          pointerType: 'mouse',
          isPrimary: true,
          bubbles: true,
        }),
      );
    });
    expect(await translateXColunas(page)).toBe(0);

    // Movimentos subsequentes do mouse sem botão pressionado não voltam a arrastar a página.
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      vp.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 7,
          pointerType: 'mouse',
          buttons: 0,
          isPrimary: true,
          clientX: 90,
          clientY: 200,
          bubbles: true,
        }),
      );
    });
    expect(await translateXColunas(page)).toBe(0);

    // 2) Fallback: pointermove com mouse e buttons === 0 encerra o gesto mesmo sem lostpointercapture.
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      vp.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 8,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          isPrimary: true,
          clientX: 240,
          clientY: 200,
          bubbles: true,
        }),
      );
      vp.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 8,
          pointerType: 'mouse',
          buttons: 1,
          isPrimary: true,
          clientX: 150,
          clientY: 200,
          bubbles: true,
        }),
      );
    });
    expect(await translateXColunas(page)).toBeLessThan(-20);

    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      vp.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 8,
          pointerType: 'mouse',
          buttons: 0,
          isPrimary: true,
          clientX: 120,
          clientY: 200,
          bubbles: true,
        }),
      );
    });
    expect(await translateXColunas(page)).toBe(0);
  });
});
