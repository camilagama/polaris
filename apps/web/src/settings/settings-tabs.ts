import { useEffect, useState } from "react";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { loadAuthMethods } from "../sign-in/sign-in-model";

/** What decides which tabs of Configurações da loja a person has. */
export interface SettingsTabConditions {
  /** `billing:manage` with the self-service on (AS-19). */
  billing: boolean;
  /** `organization:export`: asking for and downloading the copy of the store's data (ADR 0078). */
  dataExport: boolean;
}

/** What decides which tabs of Minha conta a person has. */
export interface AccountTabConditions {
  /** The offline runtime is built in. */
  offline: boolean;
  /** The server said the password is on; false while it has not said, or when it is off. */
  passwordOn: boolean;
}

/** Which tab of Configurações da loja this person has: Formas de receber and Catálogo público always, the rest by condition. */
export function settingsTabsShown(
  conditions: SettingsTabConditions
): Record<string, boolean> {
  return {
    assinatura: conditions.billing,
    "catalogo-publico": true,
    "formas-de-receber": true,
    "seus-dados": conditions.dataExport,
  };
}

/** Which tab of Minha conta this person has: Senha with the password on, Aparelhos with the offline runtime. */
export function accountTabsShown(
  conditions: AccountTabConditions
): Record<string, boolean> {
  return {
    aparelhos: conditions.offline,
    senha: conditions.passwordOn,
  };
}

/** What the server last said about the password (not a failed read), kept for the life of the page so the screens open with their tabs settled. */
let knownPasswordOn: boolean | null = null;

/** Whether the password is on (ADR 0100, AC-46); null while the server has not said, and always null with `enabled` false. */
export function usePasswordOn(enabled = true): boolean | null {
  const [on, setOn] = useState<boolean | null>(knownPasswordOn);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let current = true;
    loadAuthMethods()
      .then((methods) => {
        if (methods !== null) {
          knownPasswordOn = methods.emailPassword;
        }
        if (current) {
          setOn(methods?.emailPassword ?? knownPasswordOn === true);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled ? on : null;
}

/**
 * Whether the menu of the circle offers Minha conta: with the offline runtime it always has Aparelhos, so the server is
 * not asked; without it, only a person with the password on has a tab there.
 */
export function useHasAccountScreen(): boolean {
  const passwordOn = usePasswordOn(!OFFLINE_RUNTIME_ENABLED);
  return OFFLINE_RUNTIME_ENABLED || passwordOn === true;
}
