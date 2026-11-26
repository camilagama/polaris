import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import type { ReactNode } from "react";
import { Block, BlockHeader, BlockPanel } from "@/ui/block";
import { TextLink } from "@/ui/text-link";
import { HELP_LABEL } from "../app-shell/navigation-model";
import { ScreenTitle, TitleLine } from "../app-shell/screen-title";
import { DPO_EMAIL, mailtoHref, SUPPORT_EMAIL } from "../lib/support-contact";

export const HELP_INTRO =
  "O Polaris não tem chat nem telefone. Escreva um e-mail e diga o nome da loja e o que aconteceu.";
export const SUPPORT_LINE = "Dúvidas sobre o app, a assinatura ou um erro.";
export const DPO_LINE =
  "Pedidos e dúvidas sobre os seus dados pessoais ou sobre a Política de Privacidade vão ao encarregado (DPO).";
export const BEFORE_WRITING = [
  "Se o app não abre ou mostra erro, recarregue a página e tente de novo.",
  "Anote a versão do app: ela fica no fim de Configurações.",
] as const;

function AddressLink({ address, label }: { address: string; label: string }) {
  return (
    <TextLink
      aria-label={`${label}: ${address}`}
      className="w-fit max-w-full select-text font-medium text-base [overflow-wrap:anywhere]"
      href={mailtoHref(address)}
    >
      {address}
    </TextLink>
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
    <Block aria-labelledby={id}>
      <BlockHeader id={id} title={title} />
      <BlockPanel className="gap-2">
        <p className="m-0 text-muted-foreground text-sm">{children}</p>
        <AddressLink address={address} label={label} />
      </BlockPanel>
    </Block>
  );
}

/**
 * Ajuda e contato: static text and two `mailto:` links, no request of its own, so the page opens offline from the copy of
 * the shell. The addresses are the ones of the legal texts (`lib/support-contact`).
 */
export function HelpPage() {
  return (
    <div className="grid max-w-[40rem] gap-6">
      <div className="grid gap-4">
        <header className="grid gap-1">
          <TitleLine>
            <ScreenTitle>{HELP_LABEL}</ScreenTitle>
          </TitleLine>
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
      </div>
      <section aria-labelledby="ajuda-antes" className="grid gap-2">
        <h2 className="text-section" id="ajuda-antes">
          Antes de escrever
        </h2>
        <ul className="m-0 grid list-disc gap-1 pl-5 text-muted-foreground">
          <li>{BEFORE_WRITING[0]}</li>
          <li>
            {BEFORE_WRITING[1]}{" "}
            <TextLink href="/configuracoes#versao-do-app">
              Ver a versão
            </TextLink>
          </li>
        </ul>
      </section>
      <p className="m-0 flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground text-sm">
        <TextLink
          href={LEGAL_PATHS.terms}
          rel="noopener noreferrer"
          target="_blank"
        >
          Termos de Uso
        </TextLink>
        <TextLink
          href={LEGAL_PATHS.privacy}
          rel="noopener noreferrer"
          target="_blank"
        >
          Política de Privacidade
        </TextLink>
      </p>
    </div>
  );
}
