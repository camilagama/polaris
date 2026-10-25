import type { BillingPlanView } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { CardContent } from "@/ui/card";
import { useConnectionNoticeForm } from "../app-shell/connection-required-notice";
import { useSignedInUser } from "../app-shell/signed-in-email";
import { canManageBilling } from "../lib/billing-access";
import { useConnectionReturn, workerAnswers } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { isConnectionFailure } from "../lib/rpc-error";
import { useNow } from "../lib/use-now";
import { rememberPlanNotice } from "./plan-notice";
import {
  abandonedCheckoutText,
  type CheckoutReturn,
  checkoutRefusal,
  checkoutReturnOf,
  planHeadline,
  REREAD_EVERY_MS,
  REREAD_FOR_MS,
  type Refusal,
  readRefusal,
  safeProviderUrl,
  UNCONFIRMED_RETURN_TEXT,
  waitsForProvider,
} from "./subscription-model";
import { type CheckoutRequest, OfferCard } from "./subscription-offer";
import {
  PlanCard,
  PlanLoadError,
  PlanLoading,
  SubscriptionFooter,
} from "./subscription-parts";
import {
  CardConfirming,
  type PixHandoff,
  PixWaiting,
  WaitingLine,
} from "./subscription-waiting";

function Title() {
  return <h1 className="text-title">Assinatura</h1>;
}

/** The screen for someone who may not open it: what it is not, and nothing to do (AS-19). */
function Unavailable({ text }: { text: string }) {
  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <Title />
      <Alert>
        <AlertDescription>{text}</AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * The Assinatura (corte assinatura-e-cancelar, B; design t268 v2, § 11): only for whom has `billing:manage`, with the
 * billing self-service on. The server says the same (`FORBIDDEN billing_manage_required`, `NOT_FOUND`): the screen
 * only does not ask.
 */
export function SubscriptionPage() {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  if (!billingSelfService) {
    return <Unavailable text="A assinatura não está disponível agora." />;
  }
  if (!canManageBilling(billingSelfService, organization.role)) {
    return (
      <Unavailable text="Só o dono da loja pode ver e mudar a assinatura." />
    );
  }
  return (
    <SubscriptionScreen key={organizationId} organizationId={organizationId} />
  );
}

/** The return of the card's page, read once: the address keeps it for a reload, and it leaves no trace elsewhere. */
function useCheckoutReturn(): CheckoutReturn | null {
  return useMemo(() => checkoutReturnOf(window.location.search), []);
}

/** The plan as the server reads it now: each read supersedes the one before; a cut read is said by the shell. */
function usePlan(organizationId: string) {
  const [plan, setPlan] = useState<BillingPlanView | null>(null);
  const [loadError, setLoadError] = useState<Refusal | null>(null);
  const [loading, setLoading] = useState(true);
  // the plan that did not load because the tab is offline: the return of the connection reads it
  const [stale, setStale] = useState(false);
  const latestRead = useRef(0);

  const load = useCallback(async () => {
    latestRead.current += 1;
    const read = latestRead.current;
    setLoading(true);
    try {
      const next = await orpcClient.billing.readPlan({ organizationId });
      if (read === latestRead.current) {
        setPlan(next);
        setLoadError(null);
        setStale(false);
        rememberPlanNotice(organizationId, next);
      }
    } catch (error) {
      const offline = isConnectionFailure(error) && !(await workerAnswers());
      if (read === latestRead.current) {
        // offline, the shell's notice says it; nothing of before is shown as the plan of now (AS-8)
        setStale(offline);
        setLoadError(offline ? null : readRefusal(error));
      }
    } finally {
      if (read === latestRead.current) {
        setLoading(false);
      }
    }
  }, [organizationId]);

  useEffect(() => {
    load().catch(() => undefined);
    return () => {
      latestRead.current += 1;
    };
  }, [load]);

  return { load, loadError, loading, plan, stale };
}

/**
 * While the plan waits for the provider's fact, it is read again every 5 s for 2 min; then the screen says so and
 * offers "Atualizar" (T-1). The clock starts with the wait and stops with it; "Atualizar" starts it again.
 */
function useRereadWhileWaiting(input: {
  load: () => Promise<void>;
  /** A read that failed stops the reading: its alert has "Tentar novamente". */
  paused: boolean;
  plan: BillingPlanView | null;
  waiting: boolean;
}) {
  const { load, paused, plan, waiting } = input;
  const [waitedOut, setWaitedOut] = useState(false);
  const waitingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!waiting) {
      waitingSince.current = null;
      setWaitedOut(false);
      return;
    }
    if (paused || plan === null) {
      return;
    }
    waitingSince.current ??= Date.now();
    if (Date.now() - waitingSince.current >= REREAD_FOR_MS) {
      setWaitedOut(true);
      return;
    }
    const timer = window.setTimeout(() => {
      load().catch(() => undefined);
    }, REREAD_EVERY_MS);
    return () => window.clearTimeout(timer);
    // `plan` too: each answer schedules the next read
  }, [waiting, paused, load, plan]);
  const restart = useCallback(() => {
    waitingSince.current = null;
    setWaitedOut(false);
  }, []);
  return { restart, waitedOut };
}

/**
 * What the screen shows around the plan: the offer (a Free store, or one waiting for the method that chose to start
 * again or came back from the card's page without paying), or the confirmation of the card's return.
 */
function screenParts(input: {
  choosingAgain: boolean;
  pix: PixHandoff | null;
  plan: BillingPlanView | null;
  returned: CheckoutReturn | null;
  waitedOut: boolean;
  waiting: boolean;
}) {
  const { choosingAgain, pix, plan, returned, waitedOut, waiting } = input;
  const choosing =
    choosingAgain || returned === "cancelada" || returned === "expirada";
  // a Free store whose fact did not come in 2 min gets the offer back: an old tab or a bookmark with
  // `?retorno=concluida` must not hide it for good (a checkout already paid is refused with its own text)
  const stillFree =
    plan !== null &&
    (plan.state === "free" || plan.state === "free_over_limit");
  const confirming =
    plan !== null &&
    returned === "concluida" &&
    waiting &&
    pix === null &&
    !(waitedOut && stillFree);
  // the offer is back with the notice: the person may have paid already, and must not pay twice
  const unconfirmed =
    plan !== null &&
    returned === "concluida" &&
    waitedOut &&
    stillFree &&
    pix === null;
  const showOffer =
    plan !== null &&
    !confirming &&
    pix === null &&
    (plan.state === "free" ||
      plan.state === "free_over_limit" ||
      (plan.state === "trial_setup" && choosing));
  return { choosing, confirming, showOffer, unconfirmed };
}

function grantsPro(plan: BillingPlanView | null): boolean {
  return (
    plan !== null &&
    (plan.state === "trialing" ||
      plan.state === "active" ||
      plan.state === "grace")
  );
}

/** The part of the plan's card that waits for the provider: Pix to approve, or the method. */
function WaitingPart({
  onChooseAgain,
  onReread,
  pix,
  waitingForMethod,
  waitedOut,
}: {
  onChooseAgain: () => void;
  onReread: () => void;
  pix: PixHandoff | null;
  waitingForMethod: boolean;
  waitedOut: boolean;
}) {
  if (pix !== null) {
    return (
      <PixWaiting
        handoff={pix}
        onChooseAgain={onChooseAgain}
        onReread={onReread}
        waitedOut={waitedOut}
      />
    );
  }
  if (!waitingForMethod) {
    return null;
  }
  return (
    <CardContent className="grid gap-2 border-t pt-(--card-spacing)">
      <WaitingLine
        onReread={onReread}
        text="Conferindo a aprovação a cada 5 segundos…"
        waitedOut={waitedOut}
      />
      <div>
        <Button onClick={onChooseAgain} type="button" variant="ghost">
          Escolher outra forma de pagamento
        </Button>
      </div>
    </CardContent>
  );
}

/** The checkout the offer starts: the card leaves for the provider's page, Pix Automático shows its code here. */
function useCheckout(input: {
  afterPix: (handoff: PixHandoff) => void;
  online: boolean;
  organizationId: string;
}) {
  const { afterPix, online, organizationId } = input;
  const [pending, setPending] = useState(false);
  // the page left for the provider's: only then does coming back free the button
  const redirected = useRef(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const start = useCallback(
    async (request: CheckoutRequest) => {
      if (pending || !online) {
        return;
      }
      setPending(true);
      setRefusal(null);
      try {
        const { handoff } = await orpcClient.billing.startCheckout({
          ...request,
          organizationId,
        });
        if (handoff.kind === "redirect") {
          const url = safeProviderUrl(handoff.url);
          if (url !== null) {
            // the button stays off until the page leaves: a second click opens no second checkout (AS-18)
            redirected.current = true;
            window.location.assign(url);
            return;
          }
          setRefusal(checkoutRefusal(null));
        } else {
          afterPix({ emv: handoff.emv, url: safeProviderUrl(handoff.url) });
        }
      } catch (error) {
        setRefusal(checkoutRefusal(error));
      }
      setPending(false);
    },
    [afterPix, online, organizationId, pending]
  );
  // back from the provider's page through the browser's history (bfcache): the page left, the button works again
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted && redirected.current) {
        redirected.current = false;
        setPending(false);
      }
    };
    // an installed app opens the provider's page over itself: coming back to it, the button works again
    const onVisible = () => {
      if (document.visibilityState === "visible" && redirected.current) {
        redirected.current = false;
        setPending(false);
      }
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const clearRefusal = useCallback(() => setRefusal(null), []);
  return { clearRefusal, pending, refusal, start };
}

function SubscriptionScreen({ organizationId }: { organizationId: string }) {
  const returned = useCheckoutReturn();
  const now = useNow(60_000);
  const user = useSignedInUser();
  const payerDefaults = useMemo(
    () => ({ email: user.email ?? "", name: user.name ?? "" }),
    [user.email, user.name]
  );
  const { load, loadError, loading, plan, stale } = usePlan(organizationId);
  const [pix, setPix] = useState<PixHandoff | null>(null);
  // a store waiting for the method may start again (abandoning spends nothing, RN:6)
  const [choosingAgain, setChoosingAgain] = useState(false);
  const online = useConnectionReturn(() => {
    load().catch(() => undefined);
  });

  const granted = grantsPro(plan);
  useEffect(() => {
    if (granted) {
      setPix(null);
      setChoosingAgain(false);
    }
  }, [granted]);

  const waiting =
    plan !== null &&
    (waitsForProvider(plan, returned) || (pix !== null && !granted));
  const { restart, waitedOut } = useRereadWhileWaiting({
    load,
    paused: loadError !== null || !online,
    plan,
    waiting,
  });
  const afterPix = useCallback(
    (handoff: PixHandoff) => {
      setPix(handoff);
      setChoosingAgain(false);
      restart();
      load().catch(() => undefined);
    },
    [load, restart]
  );
  const { clearRefusal, pending, refusal, start } = useCheckout({
    afterPix,
    online,
    organizationId,
  });
  const reread = useCallback(() => {
    restart();
    clearRefusal();
    load().catch(() => undefined);
  }, [clearRefusal, load, restart]);
  const chooseAgain = useCallback(() => {
    setPix(null);
    setChoosingAgain(true);
  }, []);

  const { choosing, confirming, showOffer, unconfirmed } = screenParts({
    choosingAgain,
    pix,
    plan,
    returned,
    waitedOut,
    waiting,
  });
  // the payer's fields are a form while they show: offline, the notice says what was typed stays
  useConnectionNoticeForm(showOffer && !stale);
  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <Title />
      {/* offline the shell's notice is the whole screen: never a plan of before (AS-8); hidden, not taken away, so
          what was typed in the offer stays */}
      <div className="grid gap-4" hidden={!online}>
        {loadError ? (
          <PlanLoadError onRetry={reread} refusal={loadError} />
        ) : null}
        {loading && plan === null && loadError === null && !stale ? (
          <PlanLoading />
        ) : null}
        <AbandonedNotice plan={plan} returned={returned} />
        {confirming ? (
          <CardConfirming onReread={reread} waitedOut={waitedOut} />
        ) : null}
        {plan ? (
          <PlanCard headline={planHeadline(plan, now)} plan={plan}>
            <WaitingPart
              onChooseAgain={chooseAgain}
              onReread={reread}
              pix={pix}
              waitedOut={waitedOut}
              waitingForMethod={
                plan.state === "trial_setup" && !choosing && !confirming
              }
            />
          </PlanCard>
        ) : null}
        {unconfirmed ? (
          <Alert variant="warning">
            <AlertDescription>{UNCONFIRMED_RETURN_TEXT}</AlertDescription>
          </Alert>
        ) : null}
        {showOffer && plan ? (
          <OfferCard
            now={now}
            onReread={reread}
            onStart={start}
            online={online}
            organizationId={organizationId}
            payerDefaults={payerDefaults}
            pending={pending}
            plan={plan}
            onEdit={clearRefusal}
            refusal={refusal}
          />
        ) : null}
        {plan ? <SubscriptionFooter /> : null}
      </div>
    </div>
  );
}

function AbandonedNotice({
  plan,
  returned,
}: {
  plan: BillingPlanView | null;
  returned: CheckoutReturn | null;
}) {
  const text = plan === null ? null : abandonedCheckoutText(returned, plan);
  return text ? (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
