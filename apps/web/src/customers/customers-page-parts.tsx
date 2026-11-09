import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import type { MouseEvent, Ref } from "react";
import { TITLE_ACTION_CLASS, TitleLine } from "../app-shell/screen-title";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { SearchField } from "@/ui/search-field";

/* The small parts of the customers screen: the title and the strip that says what still works without a connection. */

interface CustomersHeaderProps {
  /** The button that opens the form of a new customer; only on the list of the active ones. */
  newButton: {
    disabled: boolean;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    ref: Ref<HTMLButtonElement>;
  } | null;
}

export function CustomersHeader({ newButton }: CustomersHeaderProps) {
  return (
    <TitleLine
      action={
        newButton ? (
          <Button
            className={TITLE_ACTION_CLASS}
            disabled={newButton.disabled}
            onClick={newButton.onClick}
            ref={newButton.ref}
            type="button"
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            Novo cliente
          </Button>
        ) : null
      }
    >
      <h1 className="text-title">Clientes</h1>
    </TitleLine>
  );
}

/** Said while there is no connection: what still works from this device and what waits for the server. */
export function OfflineNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>
        Cadastrar e editar funciona e é enviado quando a conexão voltar;
        arquivar, restaurar e anonimizar precisam de conexão.
      </AlertDescription>
    </Alert>
  );
}

interface CustomerSearchProps {
  onChange: (value: string) => void;
  value: string;
}

/** The search of the list, as in Produtos: by name, phone or e-mail, on the rows already read. */
export function CustomerSearch({ onChange, value }: CustomerSearchProps) {
  return (
    <SearchField
      className="md:max-w-sm"
      label="Buscar cliente"
      narrowBelowRem={15}
      onValueChange={onChange}
      placeholder="Nome, telefone ou e-mail"
      value={value}
    />
  );
}
