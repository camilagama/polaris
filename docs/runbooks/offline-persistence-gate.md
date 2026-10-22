# PR12 — Gate de persistência offline

## Objetivo e limite da prova

Este laboratório sintético verifica se dados locais e mutations pendentes sobrevivem a recarga, fechamento e reabertura de aba, duas abas, migração de schema, falha do arquivo OPFS e restauração do BFCache. Ele não chama a API Polaris, Neon, Hyperdrive, Better Auth ou dados de tenant. O botão de “mock server” só alterna o executor local de replay.

O gate avalia persistência depois que a página foi carregada. O app shell não tem service worker nesta POC; abrir o site sem rede antes de carregá-lo não é um critério aprovado por este laboratório.

## Armazenamento exercitado

- Coleções locais v1/v2 usam TanStack DB com SQLite no OPFS.
- O outbox de mutations e os receipts do mock server usam bancos IndexedDB separados entre si e das coleções. Um journal IndexedDB separado e Web Locks permitem retomar e serializar um reset interrompido entre abas antes de abrir o runtime. O teste de eviction remove somente o arquivo OPFS da POC para demonstrar que uma mutation pendente pode ser restaurada pelo outbox.
- A troca do mock server para online executa uma função sintética com idempotency key e grava um receipt local. Isso não é entrega remota nem prova de exatamente uma vez no servidor.
- Falha de OPFS/IndexedDB é explícita. O runtime não degrada silenciosamente para memória ou `localStorage`.
- Schema v2 tem outro ID de coleção. A cópia v1→v2 é explícita, repetível e mantém v1. Nenhum reset destrutivo de coleção é aceito como migração.
- O botão de eviction simula a remoção do arquivo nomeado da POC; não força nem prevê a política real de eviction do sistema operacional.

## Maturidade e riscos conhecidos

- A versão travada é `@tanstack/db@0.12.1`; o README do pacote a identifica como alpha. Esta POC ainda não prova a estabilidade de longo prazo do provider.
- O fluxo exercita migração de aplicação entre IDs de coleção versionados e mantém v1 para rollback. Ele não prova migração provider-native ao mudar `schemaVersion` mantendo o mesmo ID; esse caminho fica deliberadamente fora do gate porque a estratégia adotada falha fechada em incompatibilidade e não faz reset destrutivo.
- A build da POC gera `index` de 238,6 KiB, chunk do laboratório de 491,4 KiB e worker OPFS de 1.658,8 KiB. Vite avisa sobre chunks acima de 500 kB. Cold-start e consumo de dados móveis precisam ser avaliados no iPhone antes de considerar incorporar esta dependência ao app principal.

## Automação

Na raiz do monorepo:

```powershell
bun install --frozen-lockfile
Push-Location apps/web
bunx playwright install chromium
bun run test:offline-poc
Pop-Location
```

A suíte exercita reload, fechamento/reabertura de aba, replay idempotente, outbox preservado após remoção do arquivo OPFS, migração v1→v2 e coordenação entre duas abas. O CI executa Chromium desktop e Chromium com emulação Pixel 5, com vários workers no CI (um núcleo a menos que o runner, de 2 a 3; um só fora dele), não um por núcleo, por causa da pressão de memória do WASM (`E2E_WORKERS` muda; ver [testes de tela](testes-de-tela.md#duas-sessões-ao-mesmo-tempo)). O WebKit do Playwright 26.6 instalado no Windows expõe `navigator.storage.getDirectory()`, mas `createSyncAccessHandle()` no worker falha com `UnknownError` transitório; por isso ele fica fora do gate automatizado obrigatório. Esse resultado não representa Safari no iPhone. Emulação mobile também não é evidência de Android Chrome real.

## Teste manual no iPhone

Use a URL temporária de preview fornecida para a revisão. O preview contém somente dados fictícios e não deve receber dados reais.

1. Abra `/offline-poc?release=1` no Safari em uma aba normal e aguarde OPFS, SQLite e IndexedDB indicarem disponibilidade.
2. Crie uma nota sintética e confirme que ela aparece no outbox.
3. Recarregue a página e confirme que a nota e o outbox continuam presentes.
4. Feche a aba, abra a mesma URL novamente e confirme a nota e o outbox.
5. Coloque o iPhone em modo avião após a página ter carregado. Crie outra nota; ela deve ser gravada localmente. Retorne a rede, use “Colocar mock server online” e confirme que o contador do outbox zera e o receipt aumenta.
6. Coloque o mock server offline, crie uma nota para deixar uma mutation pendente e então teste o botão de eviction. Confirme que o app sinaliza o evento e restaura a mutation pendente do outbox. O botão só remove o arquivo de teste desta POC.
7. Abra `/offline-poc?release=2`, copie v1→v2 e confirme que v1 permanece e v2 recebe os registros.
8. Informe o modelo/versão do iOS, versão do Safari e o resultado de cada passo; anote qualquer erro ou indisponibilidade de OPFS/IndexedDB.

Para provar recuperação após o encerramento do processo do Safari, feche o Safari pelo seletor de apps depois de criar uma mutation e reabra-o. Esse cenário é manual no aparelho; fechar uma aba em Playwright não equivale a encerrar o processo real.

## Matriz de evidências

| Cenário | Evidência | Estado |
| --- | --- | --- |
| Chromium desktop | Playwright local e CI | Automatizado |
| Chromium mobile | Emulação Pixel 5 | Automatizado; não substitui Android físico |
| WebKit desktop (Playwright Windows) | Probe local: `createSyncAccessHandle()` falha com `UnknownError` transitório | Fora do gate obrigatório; não representa Safari iOS |
| Edge desktop real | Sem evidência específica; o job Playwright usa Chromium | Adiado; validação dedicada não executada |
| Safari/iPhone | iPhone 12, iOS 26.6.2, navegação normal; responsável confirma o roteiro completo sem erros | Aprovado manualmente (relato do responsável; 2026-10-07) |
| Android Chrome real | Aparelho não disponível nesta validação | Adiado; requer aparelho físico |
| Offline do app shell | Sem service worker nesta POC | Fora do escopo / não comprovado |

## Critério de decisão



Registrar como aprovado somente após CI verde e a validação manual do iPhone sem falha de persistência, migração ou replay. Se iOS não oferecer OPFS/IndexedDB conforme requerido, deixar o gate reprovado e decidir fallback com evidência do aparelho. Android real permanece explicitamente adiado até haver aparelho para teste; a emulação não altera esse status.

Validação manual registrada em 2026-10-07: o responsável confirmou Safari no iPhone 12/iOS 26.6.2 em navegação normal; todos os cenários propostos passaram sem erros. Após o teste, o Worker e o Preview temporários foram removidos; ambos os endereços retornaram HTTP 404.
