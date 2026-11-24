import { test, expect, abrirEstante, importarEFechar, abrirLivro, mostrarHud, aguardarAssentar } from './helpers';

test.describe('Desempenho', () => {
  test('abrir o TXT de 300 mil caracteres e virar 50 páginas', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);
    await importarEFechar(page, ['longo.txt']);

    // Deixa a leitura no meio de um capítulo longo (~100 mil caracteres) e volta à estante.
    await abrirLivro(page, 'O Grande Livro de Teste');
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.locator('.reader-toc-item', { hasText: 'Capítulo 2' }).click();
    await aguardarAssentar(page);
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1200);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    // Tempo do toque no cartão até a primeira página com texto visível (medido dentro da página).
    const abrirMs = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const card = document.querySelector<HTMLElement>('.lib-card')!;
          const t0 = performance.now();
          const timeout = setTimeout(() => reject(new Error('leitor não abriu')), 20_000);
          const verificar = () => {
            const st = document.querySelector('.reader-status-page')?.textContent ?? '';
            const p = document.querySelector('.reader-columns p');
            if (/Pág\. \d+ de (\d{2,})/.test(st) && p && p.getBoundingClientRect().width > 0 && (document.querySelector('.reader-columns')?.textContent?.length ?? 0) > 50_000) {
              requestAnimationFrame(() => {
                clearTimeout(timeout);
                resolve(performance.now() - t0);
              });
              return true;
            }
            return false;
          };
          const obs = new MutationObserver(() => {
            if (verificar()) obs.disconnect();
          });
          obs.observe(document.body, { childList: true, subtree: true, characterData: true });
          card.click();
        }),
    );

    // 50 viradas seguidas: cada uma medida do keydown até o quadro seguinte pintado.
    const tempos = await page.evaluate(async () => {
      const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const out: number[] = [];
      await raf();
      for (let i = 0; i < 50; i++) {
        const antes = document.querySelector('.reader-status-page')!.textContent;
        const t = performance.now();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        void document.querySelector<HTMLElement>('.reader-columns')!.getBoundingClientRect(); // força o layout
        await raf();
        out.push(performance.now() - t);
        if (document.querySelector('.reader-status-page')!.textContent === antes) throw new Error(`a página não mudou na virada ${i}`);
      }
      return out;
    });
    const media = tempos.reduce((a, b) => a + b, 0) / tempos.length;
    const max = Math.max(...tempos);
    const resumo = `abrir ${abrirMs.toFixed(0)} ms; virar 50 páginas: média ${media.toFixed(1)} ms, máx ${max.toFixed(1)} ms`;
    console.log(`[${info.project.name}] ${resumo}`);
    info.annotations.push({ type: 'desempenho', description: resumo });
    expect(abrirMs, `abrir (${resumo})`).toBeLessThan(1500);
    expect(media, `média por página (${resumo})`).toBeLessThan(50);
  });
});
