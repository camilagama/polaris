# Privacidade

- Coletar dado pessoal somente para propósito declarado de produto, operação, segurança ou obrigação legal. Ao adicionar campo, registrar implicações para offline, exportação, logs, retenção e exclusão.
- Polaris atua como controlador para conta, autenticação, assinatura, segurança, antifraude e suporte. Em geral, atua como operador dos dados de clientes cadastrados pelo revendedor; confirmar o papel por atividade de tratamento antes do lançamento.
- Pedido de privacidade de cliente do revendedor normalmente é tratado pelo revendedor como controlador. Não apagar dado tenant só porque terceiro sem autoridade enviou email ao Polaris.
- Encerramento de organização bloqueia novas operações, revoga acesso e autorização offline e despublica o catálogo; dados elegíveis são apagados após a janela de recuperação documentada.
- Exportação ocorre mediante pedido autorizado, em artefato privado temporário com validade curta.
- Purge abrange banco, masters de imagem, derivados, caches e cópias de staging. Restore reaplica o deletion ledger antes de reutilizar o ambiente.
- Prazos legais de retenção e de incidentes exigem revisão jurídica e contábil antes do go-live.
- Emails de verificação e recuperação enviados via Resend compartilham com o provider o endereço destinatário, link/token transacional e metadados de entrega. Antes de habilitar envio real, incluir esse tratamento na política de privacidade e revisar termos/DPA, região e retenção do provider; não enviar dados de negócio nesses emails.
