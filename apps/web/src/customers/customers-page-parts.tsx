import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";

/* The small parts of the customers screen: the title and the strip that says what still works without a connection. */

export function CustomersHeader() {
  return <h1 className="text-title">Clientes</h1>;
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
