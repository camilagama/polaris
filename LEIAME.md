# t313: recusa por limite de variantes no cadastro (corte 61b, etapa 1)

Capturas do erro do cadastro de produto com a API simulada (409, `entitlement_limit_reached`), tiradas no último commit do PR: `da1fb3ca02643fc2098844ea14e07dacb8ef28d9`.

| Arquivo | Estado | Largura | Tema |
|---|---|---|---|
| limite-360-claro.png | erro de limite, formulário preservado | 360x740 | claro |
| limite-360-escuro.png | idem | 360x740 | escuro |
| limite-1280-claro.png | idem | 1280x800 | claro |
| limite-1280-escuro.png | idem | 1280x800 | escuro |

Não capturados (o contrato do corte só pede o estado de erro): vazio, carregando, offline e sucesso do cadastro não mudaram. 320 px não foi capturado. Capturas de página inteira (fullPage): a barra inferior fixa aparece no meio da página a 360 px.
