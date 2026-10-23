import type { SaleDetailReadModel } from "@polaris/contracts";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import "./sale-legacy.css";
import { SaleCancelPanel } from "./sale-cancel-panel";
import type { SaleNotice } from "./sale-cancellation-model";
import {
  isLatestRequest,
  nextRequestToken,
  type RequestSequence,
} from "./sale-customer-link-model";
import { SaleCustomerPanel } from "./sale-customer-panel";
import type { Loadable } from "./sale-form-model";
import { SaleStatusBadges } from "./sale-history-list";
import {
  cancelOffer,
  detailLoadErrorMessage,
  type SaleDetailView,
  saleCustomerHref,
  saleDetailView,
} from "./sale-history-model";
import { SaleIdForm } from "./sale-id-form";
import { SaleNoticeRegion } from "./sale-notice-region";
import { SaleReceipt } from "./sale-receipt";
import { SaleReturnPanel } from "./sale-return-panel";
import { useSaleIdParam } from "./use-sale-id-param";

/** The root of a piece of the screen on the new interface (`data-ui`, as the other migrated screens write it). */
const UI_ROOT = "grid gap-4 font-sans text-foreground text-sm antialiased";
/** A link on a line of its own: it gets the 48 px touch area. */
const LINK =
  "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

function StateCard({
  children,
  role,
}: {
  children: ReactNode;
  role?: "status";
}) {
  return (
    <Card className="items-center px-(--card-spacing) text-center" role={role}>
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
}

interface DetailContentProps {
  organizationId: string;
  saleId: string;
}

function SaleDetailContent({ organizationId, saleId }: DetailContentProps) {
  const [load, setLoad] = useState<Loadable<SaleDetailReadModel>>({
    status: "loading",
  });
  const [notice, setNotice] = useState<SaleNotice | null>(null);
  // the sale changed and the detail is being read again: what the page offers is still the old state
  const [refreshing, setRefreshing] = useState(false);
  const sequence = useRef<RequestSequence>({ current: 0 });

  const loadDetail = useCallback(async () => {
    const token = nextRequestToken(sequence.current);
    setLoad((current) =>
      current.status === "ready" ? current : { status: "loading" }
    );
    try {
      const value = await orpcClient.sale.get({ organizationId, saleId });
      if (isLatestRequest(sequence.current, token)) {
        setLoad({ status: "ready", value });
      }
    } catch (error) {
      if (isLatestRequest(sequence.current, token)) {
        setLoad({ message: detailLoadErrorMessage(error), status: "error" });
      }
    }
  }, [organizationId, saleId]);

  useEffect(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);

  const handleRetry = useCallback(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);
  const handleSaleChanged = useCallback(
    (next: SaleNotice) => {
      setNotice(next);
      // only after a success, whose panel is done: a failure keeps the panel mounted, with its locked attempt
      setRefreshing(next.ok);
      loadDetail()
        .catch(() => undefined)
        .then(() => setRefreshing(false));
    },
    [loadDetail]
  );

  return (
    <>
      <div className={UI_ROOT} data-ui="">
        <SaleNoticeRegion notice={notice} />
        {load.status === "loading" ? (
          <StateCard role="status">Carregando venda…</StateCard>
        ) : null}
        {load.status === "error" ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {load.message}
              <Button
                onClick={handleRetry}
                size="sm"
                type="button"
                variant="link"
              >
                <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                Tentar novamente
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {load.status === "ready" ? (
          <ReadyDetailTop detail={load.value} refreshing={refreshing} />
        ) : null}
      </div>
      {load.status === "ready" ? (
        <ReadyDetailPanels
          detail={load.value}
          onSaleChanged={handleSaleChanged}
          organizationId={organizationId}
          refreshing={refreshing}
          saleId={saleId}
        />
      ) : null}
    </>
  );
}

/** Returns already made. */
function ReturnsHistory({ view }: { view: SaleDetailView }) {
  if (view.returnsHistory.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="sale-returns-title">
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-3 py-(--card-spacing)">
          <h2 className="text-section" id="sale-returns-title">
            Devoluções
          </h2>
          <ul className="grid gap-3">
            {view.returnsHistory.map((entry) => (
              <li
                className="grid gap-1 border-border border-t pt-3 first:border-t-0 first:pt-0"
                key={entry.id}
              >
                <p className="[overflow-wrap:anywhere]">
                  <strong className="font-medium">{entry.dateText}</strong> ·{" "}
                  {entry.reasonText}
                </p>
                {entry.noteText ? (
                  <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
                    Observação: {entry.noteText}
                  </p>
                ) : null}
                <ul className="grid gap-0.5 text-support">
                  {entry.lines.map((line) => (
                    <li key={line.key}>{line.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}

interface ReadyDetailTopProps {
  detail: SaleDetailReadModel;
  refreshing: boolean;
}

/** What the detail shows on the new interface: the receipt, the returns made, and the notes about what is offered. */
function ReadyDetailTop({ detail, refreshing }: ReadyDetailTopProps) {
  const view = saleDetailView(detail);
  const offer = cancelOffer(view, refreshing);
  return (
    <>
      <SaleReceipt
        before={
          view.cancellation ? (
            <Alert role="note" variant="destructive">
              <AlertTitle>Venda cancelada</AlertTitle>
              <AlertDescription className="grid gap-2">
                <p>
                  O registro original abaixo foi preservado, sem edição. O
                  cancelamento não pode ser desfeito.
                </p>
                <dl className="grid gap-2 sm:grid-cols-2">
                  {view.cancellation.rows.map((row) => (
                    <div className="grid gap-0.5" key={row.label}>
                      <dt className="opacity-80">{row.label}</dt>
                      <dd className="[overflow-wrap:anywhere]">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </AlertDescription>
            </Alert>
          ) : null
        }
        sale={view.sale}
        status={
          <SaleStatusBadges
            returnsBadge={view.returnsBadge}
            statusLabel={view.statusLabel}
            statusTone={view.statusTone}
          />
        }
      />
      <ReturnsHistory view={view} />
      {view.allReturnedMessage ? (
        <StateCard>{view.allReturnedMessage}</StateCard>
      ) : null}
      {view.cancelBlockedReason ? (
        <Alert variant="warning">
          <AlertDescription>{view.cancelBlockedReason}</AlertDescription>
        </Alert>
      ) : null}
      {offer === "waiting" ? (
        <p className="text-muted-foreground" role="status">
          Atualizando a venda…
        </p>
      ) : null}
    </>
  );
}

interface ReadyDetailPanelsProps {
  detail: SaleDetailReadModel;
  onSaleChanged: (notice: SaleNotice) => void;
  organizationId: string;
  /** The detail is being read again after a change: cancelling waits for the new state (U-20). */
  refreshing: boolean;
  saleId: string;
}

/** Return, cancel and customer: still the old interface (they migrate in their own pull request). */
function ReadyDetailPanels({
  detail,
  onSaleChanged,
  organizationId,
  refreshing,
  saleId,
}: ReadyDetailPanelsProps) {
  const view = saleDetailView(detail);
  const offer = cancelOffer(view, refreshing);
  return (
    <>
      <div className="sale-page">
        {view.canReturn ? (
          <SaleReturnPanel
            key={view.returnPanelKey}
            onSaleChanged={onSaleChanged}
            organizationId={organizationId}
            rows={view.returnRows}
            saleId={saleId}
          />
        ) : null}
        {offer === "panel" ? (
          <SaleCancelPanel
            key={saleId}
            onSaleChanged={onSaleChanged}
            organizationId={organizationId}
            saleId={saleId}
          />
        ) : null}
        <SaleCustomerPanel
          headingLevel={2}
          key={saleId}
          organizationId={organizationId}
          saleId={saleId}
        />
      </div>
      <div className={UI_ROOT} data-ui="">
        <p>
          <a className={LINK} href={saleCustomerHref(saleId)}>
            Abrir o ajuste de cliente em uma página própria
          </a>
        </p>
      </div>
    </>
  );
}

/** One sale in full: its receipt, cancellation, and customer attribution. */
export function SaleDetailPage() {
  const { organizationId } = useCurrentOrganization();
  const { clear, initialError, open, saleId } = useSaleIdParam();
  return (
    <div className="grid gap-4">
      <div className={UI_ROOT} data-ui="">
        <header className="grid gap-1">
          <h1 className="text-title">Detalhe da venda</h1>
          <p className="text-muted-foreground text-support">
            A venda confirmada é um registro que não muda. Cancelamento e
            cliente são registros à parte.
          </p>
        </header>
        <div className="flex flex-wrap items-center gap-x-4">
          <a className={LINK} href="/sales/history">
            Voltar ao histórico
          </a>
          {saleId === null ? null : (
            <Button onClick={clear} size="sm" type="button" variant="link">
              Abrir outra venda
            </Button>
          )}
        </div>
      </div>
      {saleId === null ? (
        // still the old form: the page of the customer of a sale shares it and migrates in its own pull request
        <div className="sale-page">
          <SaleIdForm initialError={initialError} onOpen={open} />
        </div>
      ) : null}
      {saleId === null ? null : (
        <SaleDetailContent
          key={saleId}
          organizationId={organizationId}
          saleId={saleId}
        />
      )}
    </div>
  );
}
