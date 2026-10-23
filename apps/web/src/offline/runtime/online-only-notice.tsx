import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import { useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { useRuntimeSnapshot } from "./runtime-context";

function subscribeToBrowser(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

const browserIsOnline = () => navigator.onLine;
const assumeOnline = () => true;

/**
 * Offline when the browser says so or the runtime does: the runtime in its "unavailable" phase keeps no account of the
 * connection (it says `true` for good), and then the browser is the only one that knows.
 */
export function isConnected(
  browserOnline: boolean,
  runtimeOnline: boolean | undefined
): boolean {
  return browserOnline && (runtimeOnline ?? true);
}

function useIsOnline(): boolean {
  const snapshot = useRuntimeSnapshot();
  const browser = useSyncExternalStore(
    subscribeToBrowser,
    browserIsOnline,
    assumeOnline
  );
  return isConnected(browser, snapshot?.online);
}

/** The words of the strip: what the screen needs, and what it means for what was typed. */
export function OnlineOnlyStrip() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem internet.</AlertTitle>
      <AlertDescription>
        Esta tela precisa de conexão. O que você digitou fica aqui até a conexão
        voltar.
      </AlertDescription>
    </Alert>
  );
}

/**
 * The strip of a screen that works only with a connection (it reads and saves on the server), shown while there is
 * none (U-54): the chip of the shell says the same in two words, this says what it means for what was typed.
 */
export function OnlineOnlyNotice() {
  const online = useIsOnline();
  return online ? null : <OnlineOnlyStrip />;
}
