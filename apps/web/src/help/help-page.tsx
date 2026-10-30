import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardTitle } from "@/ui/card";
import { HELP_LABEL } from "../app-shell/navigation-model";
import { ScreenTitle } from "../app-shell/screen-title";
import { DPO_EMAIL, mailtoHref, SUPPORT_EMAIL } from "../lib/support-contact";

const LINK =
  "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

export const HELP_INTRO =
  "O Polaris não tem chat nem telefone. Escreva um e-mail e diga o nome da loja e o que aconteceu.";
export const SUPPORT_LINE = "Dúvidas sobre o app, a assinatura ou um erro.";
export const DPO_LINE =
  "Pedidos sobre dados pessoais, seus ou dos seus clientes, vão ao encarregado (DPO).";
export const BEFORE_WRITING = [
  "Se o app não abre ou mostra erro, recarregue a página e tente de novo.",
  "Anote a versão do app: ela fica no fim de Configurações.",
] as const;

function AddressLink({ address, label }: { address: string; label: string }) {
  return (
    <a
      aria-label={`${label}: ${address}`}
      className={`${LINK} w-fit select-text break-words font-medium text-base`}
      href={mailtoHref(address)}
    >
      {address}
    </a>
  );
}

function ContactCard({
  address,
  children,
  id,
  label,
  title,
}: {
  address: string;
  children: ReactNode;
  id: string;
  label: string;
  title: string;
}) {
  return (
    <Card aria-labelledby={id} role="region">
      <CardContent className="grid gap-2">
        <CardTitle aria-level={2} id={id} role="heading">
          {title}
        </CardTitle>
        <CardDescription className="text-sm">{children}</CardDescription>
        <AddressLink address={address} label={label} />
      </CardContent>
    </Card>
  );
}

/**
 * Ajuda e contato: static text and two `mailto:` links, no request of its own, so the page opens offline from the copy of
 * the shell. The addresses are the ones of the legal texts (`lib/support-contact`).
 */
export function HelpPage() {
  return (
    <div className="grid max-w-[640px] gap-6">
      <header className="grid gap-2">
        <ScreenTitle>{HELP_LABEL}</ScreenTitle>
        <p className="m-0 text-muted-foreground">{HELP_INTRO}</p>
      </header>
      <ContactCard
        address={SUPPORT_EMAIL}
        id="ajuda-suporte"
        label="Escrever para o suporte"
        title="Suporte"
      >
        {SUPPORT_LINE}
      </ContactCard>
      <ContactCard
        address={DPO_EMAIL}
        id="ajuda-dados-pessoais"
        label="Escrever ao encarregado de dados"
        title="Dados pessoais"
      >
        {DPO_LINE}
      </ContactCard>
      <section aria-labelledby="ajuda-antes" className="grid gap-2">
        <h2 className="text-section" id="ajuda-antes">
          Antes de escrever
        </h2>
        <ul className="m-0 grid list-disc gap-1 pl-5 text-muted-foreground">
          <li>{BEFORE_WRITING[0]}</li>
          <li>
            {BEFORE_WRITING[1]}{" "}
            <a className={LINK} href="/configuracoes#versao-do-app">
              Ver a versão
            </a>
          </li>
        </ul>
      </section>
      <p className="m-0 flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground text-sm">
        <a
          className={LINK}
          href={LEGAL_PATHS.terms}
          rel="noopener noreferrer"
          target="_blank"
        >
          Termos de Uso
        </a>
        <a
          className={LINK}
          href={LEGAL_PATHS.privacy}
          rel="noopener noreferrer"
          target="_blank"
        >
          Política de Privacidade
        </a>
      </p>
    </div>
  );
}
