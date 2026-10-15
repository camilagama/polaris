# Billing e entitlements

- Provider reporta fatos. Polaris valida e deduplica os fatos, reconcilia o estado canônico de billing e deriva entitlements; webhook não concede acesso diretamente.
- Provider não é autoridade sobre o estado do produto. Planos, assinaturas, trials, grants e entitlements são registros do Polaris.
- Uso Free não exige meio de pagamento. Trial Pro começa somente após o usuário optar e o método de renovação estar pronto.
- Cartão recorrente e Pix Automático são rails distintos; adapters não devem fingir comportamento idêntico.
- Billing e webhooks são idempotentes. Evento duplicado ou fora de ordem não pode gerar segundo efeito econômico nem retroceder estado.
- Downgrade preserva dados e histórico. Limites restringem novas operações sem apagar conteúdo.
- Preços, quotas e prazos comerciais são hipóteses ajustáveis em PRODUCT.md.
- Organização sem registro de billing está no Free. O plano em vigor depende do fim do acesso: trial, período ou carência vencidos contam como Free mesmo antes de o registro ser atualizado, e acesso Pro sempre tem data de fim.
- Concessão temporária (suporte, promoção) tem prazo e motivo, e só eleva: nunca reduz um limite nem desliga uma flag. Uma organização não concede acesso a si mesma.
- Um evento de billing que não se aplica ao estado atual é recusado, não ignorado. Sair do Pro resulta em Free, ou em Free acima do limite quando a organização tem mais do que o Free permite; os dados ficam e só novas operações são restringidas.
