# Contribuindo com o Folha

Obrigado por querer ajudar! Este guia é curto de propósito.

## Fluxo

1. Abra uma *issue* descrevendo o bug ou a ideia, ou comente em uma existente.
2. Faça um *fork*, crie uma branch a partir da `main` (`fix/...` ou `feat/...`) e faça commits pequenos e claros.
3. Abra um *pull request* explicando o que mudou e por quê; inclua capturas de tela se a interface mudou.

## Checagens obrigatórias

O CI executa o mesmo que você deve rodar antes de abrir o PR:

```bash
npm ci
npm run typecheck
npm run test:coverage
npm run build
npm run test:e2e        # quando houver mudança de interface ou fluxo
```

Mudanças no Android precisam de `cd android && ./gradlew assembleDebug lint` sem erros (JDK 21).

## Estilo

- TypeScript em modo estrito; sem `any` desnecessário.
- Sem framework de UI: DOM direto, como no restante do projeto.
- Todos os textos visíveis, comentários e nomes de testes em português do Brasil, com acentuação correta.
- Todo comportamento novo vem com teste; todo bug corrigido ganha um teste que o reproduz.
- Não adicione rastreamento, telemetria ou chamadas de rede ao app.
- Não inclua dados pessoais, chaves ou senhas em commits (`keystore.properties` e `*.jks` ficam fora do git).

Ao contribuir, você concorda em licenciar sua contribuição sob a licença MIT do projeto.
