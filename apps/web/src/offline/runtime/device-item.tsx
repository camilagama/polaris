import { type ChangeEvent, useCallback, useEffect, useRef } from "react";
import {
  confirmLabel,
  type DeviceRow,
  END_OTHER_SESSIONS_HELP,
  END_OTHER_SESSIONS_LABEL,
  END_OTHER_SESSIONS_WARNING,
  REVOKE_TITLE,
  REVOKE_WARNING,
  REVOKE_WARNING_NOTE,
  REVOKING_LABEL,
} from "./devices-model";

interface RowProps {
  /** What went wrong with the last attempt, said inside the confirmation, right above the buttons. */
  actionError: string | null;
  busy: boolean;
  confirming: boolean;
  endOtherSessions: boolean;
  offline: boolean;
  onAsk: (id: string) => void;
  onCancel: () => void;
  onChoose: (endOtherSessions: boolean) => void;
  /** There is a connection: Sair can revoke this device on the server before it leaves. */
  online: boolean;
  onRevoke: (id: string) => void;
  row: DeviceRow;
  /** The session is over (the panel above says so): no promise about what Sair does. */
  sessionGone: boolean;
}

const THIS_DEVICE_ONLINE_HELP = (
  <>
    Para tirar este aparelho, use o botão <strong>Sair</strong>: no celular ele
    está no Menu; em tela grande, no alto da página.
  </>
);
const THIS_DEVICE_OFFLINE_HELP =
  "Sem conexão, Sair não tira este aparelho da lista; ele sai quando você sair com internet, ou pode ser revogado de outro aparelho.";

export function DeviceItem({
  actionError,
  busy,
  confirming,
  endOtherSessions,
  offline,
  onAsk,
  onCancel,
  onChoose,
  onRevoke,
  online,
  row,
  sessionGone,
}: RowProps) {
  const askRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLFieldSetElement>(null);
  const focusAskAfterCancel = useRef<boolean>(false);
  const handleAsk = useCallback(() => onAsk(row.id), [onAsk, row.id]);
  const handleRevoke = useCallback(() => onRevoke(row.id), [onRevoke, row.id]);
  const handleChoose = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChoose(event.target.checked),
    [onChoose]
  );
  // focus goes to the confirmation when it opens and back to "Revogar" on Cancelar (not when another row took the confirmation)
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (focusAskAfterCancel.current) {
      focusAskAfterCancel.current = false;
      askRef.current?.focus();
    }
  }, [confirming]);
  const handleCancel = useCallback(() => {
    focusAskAfterCancel.current = true;
    onCancel();
  }, [onCancel]);
  return (
    <li className="device-item">
      <div className="device-main">
        <p className="device-name">
          {row.labelText}
          {row.isCurrent ? (
            <span className="device-badge">Este aparelho</span>
          ) : null}
        </p>
        <p className="device-meta">
          Registrado em {row.registeredText} · visto por último em{" "}
          {row.lastSeenText}
        </p>
      </div>
      {row.isCurrent && !sessionGone ? (
        <p className="device-meta">
          {online ? THIS_DEVICE_ONLINE_HELP : THIS_DEVICE_OFFLINE_HELP}
        </p>
      ) : null}
      {!row.isCurrent && confirming ? (
        <fieldset className="device-confirm" ref={confirmRef} tabIndex={-1}>
          <legend className="device-confirm-title">
            {REVOKE_TITLE}
            <span className="visually-hidden"> ({row.labelText})</span>
          </legend>
          <p className="device-confirm-warning">{REVOKE_WARNING}</p>
          <p className="device-confirm-note">{REVOKE_WARNING_NOTE}</p>
          <label className="device-check">
            <input
              aria-describedby={`${row.id}-help`}
              checked={endOtherSessions}
              disabled={busy || offline}
              onChange={handleChoose}
              type="checkbox"
            />
            <span>{END_OTHER_SESSIONS_LABEL}</span>
          </label>
          <p className="device-check-help" id={`${row.id}-help`}>
            {END_OTHER_SESSIONS_HELP}
          </p>
          {endOtherSessions ? (
            <p className="device-check-warning">{END_OTHER_SESSIONS_WARNING}</p>
          ) : null}
          {actionError ? (
            <p className="device-confirm-error" role="alert">
              {actionError}
            </p>
          ) : null}
          <div className="device-actions">
            <button
              className="danger-button"
              disabled={busy || offline}
              onClick={handleRevoke}
              type="button"
            >
              {busy ? REVOKING_LABEL : confirmLabel(endOtherSessions)}
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={handleCancel}
              type="button"
            >
              Cancelar
            </button>
          </div>
        </fieldset>
      ) : null}
      {row.isCurrent || confirming ? null : (
        <button
          aria-label={`Revogar o aparelho ${row.labelText}`}
          className="quiet-button"
          disabled={busy || offline}
          onClick={handleAsk}
          ref={askRef}
          type="button"
        >
          Revogar
        </button>
      )}
    </li>
  );
}
