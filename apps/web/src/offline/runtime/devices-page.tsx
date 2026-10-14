import type { DeviceReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useState } from "react";
import { orpcClient } from "../../lib/orpc";
import {
  type DeviceRow,
  deviceRows,
  devicesLoadError,
  REVOKE_WARNING,
  revokedMessage,
  revokeError,
} from "./devices-model";
import "./devices-page.css";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

interface RowProps {
  busy: boolean;
  confirming: boolean;
  onAsk: (id: string) => void;
  onCancel: () => void;
  onRevoke: (id: string) => void;
  row: DeviceRow;
}

function DeviceItem({
  busy,
  confirming,
  onAsk,
  onCancel,
  onRevoke,
  row,
}: RowProps) {
  const handleAsk = useCallback(() => onAsk(row.id), [onAsk, row.id]);
  const handleRevoke = useCallback(() => onRevoke(row.id), [onRevoke, row.id]);
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
      {row.isCurrent ? (
        <p className="device-meta">
          Para tirar este aparelho, use <strong>Sair</strong> no menu.
        </p>
      ) : null}
      {!row.isCurrent && confirming ? (
        <div className="device-confirm" role="alert">
          <p>{REVOKE_WARNING}</p>
          <div className="device-actions">
            <button
              className="danger-button"
              disabled={busy}
              onClick={handleRevoke}
              type="button"
            >
              Sim, revogar este aparelho
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      {row.isCurrent || confirming ? null : (
        <button
          aria-label={`Revogar o aparelho ${row.labelText}`}
          className="quiet-button"
          disabled={busy}
          onClick={handleAsk}
          type="button"
        >
          Revogar
        </button>
      )}
    </li>
  );
}

/** Lists the user's devices and lets them revoke one (lost phone). Needs a connection. */
export function DevicesPage() {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const [devices, setDevices] = useState<DeviceReadModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const currentDeviceId = runtime?.context()?.deviceId ?? null;
  const online = snapshot?.online ?? true;

  useEffect(() => {
    let current = true;
    // reloadVersion re-reads the list after a revocation or a retry
    orpcClient.device
      .list()
      .then(({ devices: found }) => {
        if (current && reloadVersion >= 0) {
          setDevices(found);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(devicesLoadError(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [reloadVersion]);

  const handleRevoke = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await orpcClient.device.revoke({ deviceId: id });
      setNotice(revokedMessage(result.revokedGrantIds.length));
      setConfirming(null);
    } catch (cause) {
      setError(revokeError(cause));
    } finally {
      setBusy(false);
      setReloadVersion((version) => version + 1);
    }
  }, []);
  const handleRevokeEvent = useCallback(
    (id: string) => {
      handleRevoke(id).catch(() => undefined);
    },
    [handleRevoke]
  );
  const handleCancel = useCallback(() => setConfirming(null), []);
  const handleRetry = useCallback(
    () => setReloadVersion((version) => version + 1),
    []
  );

  const rows = devices ? deviceRows(devices, currentDeviceId) : [];
  return (
    <div className="devices-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Segurança</p>
          <h1>Aparelhos</h1>
          <p className="categories-intro-copy">
            Os aparelhos em que você usa o Polaris offline. Se perdeu um celular
            ou computador, revogue o aparelho: o servidor deixa de aceitar o que
            ele enviar.
          </p>
        </div>
      </section>
      {online ? null : (
        <p className="categories-message is-error" role="status">
          Sem conexão. Revogar um aparelho só funciona com conexão.
        </p>
      )}
      {error ? (
        <p className="categories-message is-error" role="alert">
          {error}{" "}
          <button className="quiet-button" onClick={handleRetry} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="categories-message is-success" role="status">
          {notice}
        </p>
      ) : null}
      {devices && rows.length === 0 ? (
        <p className="category-empty-state">
          Nenhum aparelho registrado nesta conta.
        </p>
      ) : null}
      <ul aria-label="Aparelhos" className="device-list">
        {rows.map((row) => (
          <DeviceItem
            busy={busy || !online}
            confirming={confirming === row.id}
            key={row.id}
            onAsk={setConfirming}
            onCancel={handleCancel}
            onRevoke={handleRevokeEvent}
            row={row}
          />
        ))}
      </ul>
    </div>
  );
}
