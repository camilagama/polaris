import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";

/**
 * The one "Sem conexão." notice of the screens that keep working from the device (Clientes, Estoque, Histórico,
 * Produtos, Nova venda): the title, the tone and the icon are fixed here, so no screen words them its own way;
 * the screen says only what still works and what waits for the connection. It sits at the top of the screen, in
 * the flow, with no button and no close: it goes away when the connection returns. A screen that needs
 * the connection for everything has `ConnectionRequiredSlot` instead.
 */
export function OfflineNotice({
  children,
  id,
}: {
  children: ReactNode;
  id?: string | undefined;
}) {
  return (
    <Alert id={id} variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
