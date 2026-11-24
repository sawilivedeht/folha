# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento semântico.

## [Não lançado]

### Segurança
- Content-Security-Policy restritiva; o APK não pede mais a permissão de internet e o backup em nuvem foi desligado.
- EPUB: limite contra bomba de zip, SVG convertido em PNG na importação, regex do OPF/sumário em tempo linear.

### Corrigido
- PDF não importava em WebViews Android anteriores ao Chrome 128 (travava sem erro); agora usa o build legacy do pdf.js.
- Tela branca com IndexedDB indisponível ou endereço inválido; livro pela metade quando a gravação falhava por falta de espaço.
- Leitor: teclado e leitor de tela (HUD fechado inerte, foco nos painéis, slider), imagens que carregam depois, quebras de linha de `<br>`.
- Estante: erros do banco visíveis, menu de opções pelo teclado, Voltar do Android com modal aberto, ordenação por autor.
- Conversão de PDF: cabeçalhos/rodapés em duas colunas, desifenização em português, falas com travessão, sumário com várias entradas na mesma página, páginas muito grandes, camada OCR, classificação de slides.
- EPUB/TXT: codificações além de UTF-8, CDATA e comentários no OPF, tabelas e listas aninhadas, falsos capítulos em TXT, títulos de Markdown.

### Testes
- Fuzzing, corpus real, estresse, segurança, offline, memória, resiliência, gestos e acessibilidade por teclado; scripts de ciclo de vida, monkey e desempenho no emulador.

## [0.1.0] - 2026-11-24

### Adicionado
- Estante com busca, ordenação, capas geradas e importação por seleção ou arrastar-e-soltar.
- Importação de PDF (conversão para texto refluível), EPUB e TXT/Markdown.
- Leitor paginado com sumário, marcadores, progresso salvo e painel Aa (fonte, entrelinha, margens, justificação, hifenização).
- Temas claro, sépia, escuro e preto.
- Projeto Android (Capacitor) com ícone adaptativo, tela inicial e release minificado com assinatura opcional.
- Manifesto web e ícones para uso no navegador.
