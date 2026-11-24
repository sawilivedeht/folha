# Segurança e privacidade

O Folha lê arquivos que vêm de qualquer lugar (lojas, sites, amigos) e guarda tudo no aparelho. Este
documento resume o que protegemos, como, o que é testado e como reportar uma vulnerabilidade.

## Modelo de ameaças

**O que proteger:** a biblioteca (livros, capas, progresso, marcadores e preferências, no IndexedDB do app)
e a privacidade de quem lê (o que lê, quando e quanto). O app não tem contas, servidor nem telemetria.

**De quem:** de um e-book hostil. Um EPUB é um zip de XHTML, CSS, SVG e imagens escritos por terceiros; um
PDF pode trazer JavaScript, links e metadados arbitrários; um TXT pode conter HTML. Quem prepara o arquivo
pode querer executar script na origem do app (ler ou apagar a biblioteca), rastrear a leitura (pixel ou
fonte remota que "avisa" quando o livro é aberto) ou travar o app (entidades XML, arquivos gigantes).

**Fora do escopo:** quem já tem acesso ao aparelho desbloqueado, root ou depuração USB; o próprio
navegador/WebView do sistema; DRM (não existe).

### Defesas

1. **Conteúdo vira dados, não HTML.** Os importadores convertem tudo em blocos de texto (`src/types.ts`):
   parágrafos, títulos, listas, citações, código, imagens e separadores, com negrito/itálico/sobrescrito.
   Scripts, estilos, atributos, links, formulários, frames, objetos e SVG embutido são descartados. O
   XHTML é analisado com `DOMParser`, que cria um documento inerte (sem scripts e sem carregar recursos).
   O OPF, o NCX e o sumário são lidos sem expandir entidades declaradas no DTD; no XHTML, o limite de
   amplificação de entidades do parser XML do navegador barra o "billion laughs" e o importador cai no
   parser HTML, que trata `&entidade;` como texto.
2. **Renderização só com `textContent`.** O leitor e a estante nunca usam `innerHTML`: títulos, autores,
   nomes de arquivo e o texto dos livros aparecem como texto literal, mesmo que contenham `<script>`.
3. **Imagens só do próprio arquivo.** Uma imagem só é exibida se estiver dentro do EPUB; `http:`, `https:`,
   `//`, `data:` e `blob:` vindos do livro são ignorados. As imagens guardadas são mostradas por `blob:`
   criado pelo app, e SVG dentro de `<img>` não executa script nem busca recursos.
4. **Sem rede.** O código do app não faz `fetch`, XHR, WebSocket nem beacons. O pdf.js e o worker dele são
   servidos pelo próprio app (nada de CDN) e só são baixados quando um PDF é importado.
5. **Content-Security-Policy** (`<meta>` no `index.html`), como segunda camada:

   | Diretiva | Valor | Por quê |
   | --- | --- | --- |
   | `default-src` | `'none'` | tudo o que não for liberado abaixo é proibido (frames, mídia, plugins, prefetch) |
   | `script-src` | `'self'` | só os módulos do build; sem script inline e sem `eval` |
   | `style-src` | `'self' 'nonce-folha-vite-dev'` | só as folhas do build; sem `<style>` nem `style=""` inline (o app usa CSSOM, que a CSP permite) |
   | `img-src` | `'self' blob:` | ícones do app e imagens/capas lidas do IndexedDB |
   | `font-src` | `'self'` | nenhuma fonte remota (as fontes do pdf.js são carregadas da memória via `FontFace`) |
   | `connect-src` | `'self'` | nenhuma chamada para fora; `'self'` só para o HMR do servidor de desenvolvimento |
   | `worker-src` | `'self'` | o worker do pdf.js, que é um arquivo do build |
   | `manifest-src` | `'self'` | manifesto do PWA |
   | `base-uri`, `form-action` | `'none'` | essas diretivas não herdam de `default-src` |
   | `object-src` | `'none'` | explícito, por recomendação |

   Nada exige `'unsafe-inline'` nem `'unsafe-eval'`. O nonce de estilo é fixo e público: serve só para o
   servidor de desenvolvimento do Vite, que injeta o CSS em `<style>` e lê o nonce de
   `<meta property="csp-nonce">`. O build de produção não tem `<style>` inline. Como `img-src`, `font-src`
   e `connect-src` não aceitam outros hosts, nem um `<style>` injetado conseguiria vazar dados. O ideal é
   gerar a CSP só no build (plugin do Vite) e remover o nonce.

   No WebView do Capacitor (origem `https://localhost`) a política deve valer do mesmo jeito; isso foi
   verificado lendo o código do Capacitor 8, não rodando o APK: a ponte JS é injetada por
   `addDocumentStartJavaScript` ou, em WebViews antigos, num `<script>` logo depois de `<head>`, antes da
   `<meta>` da CSP (que só vale para o que vem depois dela); as respostas nativas chegam por
   `evaluateJavascript`, que a CSP não bloqueia; o worker do pdf.js e as imagens `blob:` são da mesma origem.
   O `DOMParser` herda a CSP, então um `<base href>` externo num XHTML gera um aviso "violates ... base-uri"
   no console ao importar: é a política funcionando.
6. **DoS.** Entidades XML em profundidade não expandem (ver item 1). Arquivos muito grandes e bombas de zip
   não têm limite próprio: o `unzipSync` descompacta tudo na memória (ver "Limitações").

### Dados locais

Livros, capas, progresso e ajustes ficam no IndexedDB (e a posição de leitura também num `localStorage`),
dentro do armazenamento privado do app. Excluir um livro apaga metadados, conteúdo, capa e imagens dele.
O app pede armazenamento persistente para o Android não apagar a biblioteca quando falta espaço. No
Android, o `AndroidManifest.xml` hoje permite backup (`android:allowBackup="true"`): se o backup do Google
estiver ligado no aparelho, os dados do app (incluindo a biblioteca) podem ir para a conta do usuário.

### Limitações conhecidas

- Uma imagem SVG de um EPUB aberta com "Abrir imagem em nova guia" (navegador; o WebView do APK não tem
  esse menu) vira um documento que roda o script do SVG na origem do app, sem CSP. Correção planejada:
  converter SVG em PNG na importação. Teste: `e2e/seguranca.spec.ts` (marcado como falha esperada).
- Um OPF com milhares de tags sem fechamento deixa a importação lenta por segundos (expressões regulares
  com custo quadrático). Teste: `e2e/seguranca.spec.ts` (falha esperada).
- Sem limite de tamanho descompactado para EPUB (bomba de zip pode esgotar a memória e fechar o app).
- O APK declara a permissão `INTERNET` (padrão do Capacitor), embora o app não use rede.

## O que é testado

| Teste | O que prova |
| --- | --- |
| `e2e/seguranca.spec.ts` | EPUB hostil (scripts, `on*`, `javascript:`, iframe, object, embed, form, SVG com script e `foreignObject`, `@import`, pixel de rastreamento, `srcset`, `<link>`, `<meta refresh>`, `<base>`, `data:`, atributos de MB, HTML malformado e mXSS), entidades em profundidade no OPF e no XHTML, TXT e PDF com HTML no texto e nos metadados, nome de arquivo com HTML: nenhum script roda (armadilha em `window.__pwned`), nenhuma requisição sai de localhost (todas interceptadas), o DOM só tem o que o renderizador cria e os títulos aparecem literais. Também confere que a CSP está ativa e bloqueia script inline, rede externa, frames, plugins, workers de `blob:` e estilos inline. |
| `e2e/offline.spec.ts` | Uso completo (abrir, importar PDF/EPUB/TXT, ler, mudar ajustes, marcador, sumário, excluir) com zero requisições para fora de localhost; o pdf.js e o worker só são baixados ao importar um PDF; nenhuma chamada `fetch`/XHR/WebSocket. |
| Suíte E2E inteira | Roda com a CSP aplicada e falha em qualquer `console.error`, então qualquer violação da política quebra um teste. |
| `npm audit` | Sem vulnerabilidades conhecidas nas dependências (rodar antes de cada versão). |

As fixtures hostis são geradas por `e2e/fixtures/make.mjs` e apontam para `rastreador.example`, um domínio
reservado; os testes abortam qualquer requisição para fora de localhost antes de ela sair da máquina.

## Como reportar uma vulnerabilidade

Não abra issue pública. Use **Security → Report a vulnerability** no repositório do GitHub (relato privado
de vulnerabilidade). Inclua a versão do app (ou o commit), o aparelho/navegador, os passos para
reproduzir e, se possível, um arquivo de exemplo mínimo (sem conteúdo protegido por direitos autorais nem
dados pessoais). A meta é responder em até 7 dias, corrigir e publicar uma versão antes de divulgar os
detalhes, com crédito a quem reportou, se quiser.

Licenças de terceiros: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
