import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import type { Ref } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";

/* The small parts of the customers screen: the title and the strip that says what still works without a connection. */

interface CustomersHeaderProps {
  /** The button that opens the form of a new customer; only on the list of the active ones. */
  newButton: {
    disabled: boolean;
    onClick: () => void;
    ref: Ref<HTMLButtonElement>;
  } | null;
}

export function CustomersHeader({ newButton }: CustomersHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h1 className="text-title">Clientes</h1>
      {newButton ? (
        <Button
          disabled={newButton.disabled}
          onClick={newButton.onClick}
          ref={newButton.ref}
          type="button"
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Novo cliente
        </Button>
      ) : null}
    </div>
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
