import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import type { ReactNode } from "react";
import { Button } from "@/ui/button";
import { EntryAlert, EntryScreen, EntryStatus } from "../sign-in/entry-ui";
import { LEGAL_PAGE_TITLES } from "./legal-routes";

/**
 * A page of a legal document, on the entry frame of the interface v5.1 in its reading width: brand (a link to the
 * start), title and, inside, the text or the message of a state. The brand and the title are there also when the
 * text is not yet or failed to load.
 */
export function LegalFrame({
  children,
  document,
}: {
  children: ReactNode;
  document: LegalDocumentId;
}) {
  return (
    <EntryScreen
      brandHref="/"
      legalLinks={false}
      title={LEGAL_PAGE_TITLES[document]}
      width="reading"
    >
      {children}
    </EntryScreen>
  );
}

/** The wait for the text: the brand and the title are already there. */
export function LegalLoading({ document }: { document: LegalDocumentId }) {
  return (
    <LegalFrame document={document}>
      <EntryStatus>Carregando…</EntryStatus>
    </LegalFrame>
  );
}

/** The text could not be opened: says why and offers a new try. */
export function LegalLoadFailure({
  document,
  offline,
  onRetry,
}: {
  document: LegalDocumentId;
  offline: boolean;
  onRetry: () => void;
}) {
  return (
    <LegalFrame document={document}>
      <EntryAlert>
        {offline
          ? "Sem conexão. Abra de novo quando a internet voltar."
          : "Não foi possível abrir esta página. Tente de novo."}
      </EntryAlert>
      <Button
        className="w-full sm:w-fit"
        onClick={onRetry}
        size="lg"
        type="button"
        variant="outline"
      >
        Tentar novamente
      </Button>
    </LegalFrame>
  );
}
