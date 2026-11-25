import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Block, BlockHeader, BlockPanel } from "@/ui/block";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field";
import { Label } from "@/ui/label";
import { Separator } from "@/ui/separator";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { connectionControlProps } from "../app-shell/connection-required-notice";

const TITLE_ID = "email-preference-title";
const TIPS_ID = "email-preference-tips";
const TIPS_HELP_ID = "email-preference-tips-help";

const NOTICES_LABEL = "Avisos da conta e da cobrança";
const NOTICES_HELP = "Sempre enviados: fazem parte do serviço.";
const TIPS_LABEL = "Dicas para começar";
const TIPS_HELP =
  "Até 3 e-mails nos primeiros 14 dias de uma loja nova, para ajudar a fazer a primeira venda. Vale para todas as suas lojas.";
const SAVED_TEXT = "Salvo.";
const SAVE_FAILED_TEXT = "Não deu para salvar. Tente de novo.";

export interface EmailPreference {
  sent: number;
  tips: boolean;
}

export interface EmailPreferenceCalls {
  read: () => Promise<EmailPreference>;
  readRefusal: (error: unknown) => string;
  setTips: (on: boolean) => Promise<EmailPreference>;
}

function describedBy(online: boolean) {
  const offline = connectionControlProps(online);
  return {
    ...offline,
    "aria-describedby": [TIPS_HELP_ID, offline["aria-describedby"]]
      .filter(Boolean)
      .join(" "),
  };
}

type Outcome = "failed" | "saved" | null;

function useEmailPreference(
  calls: EmailPreferenceCalls,
  retryButton: RefObject<HTMLButtonElement | null>
) {
  const [preference, setPreference] = useState<EmailPreference | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  // a second touch lands before React draws the busy state
  const savingRef = useRef<boolean>(false);
  // a read sent before a save would answer with the state from before it
  const latestRead = useRef(0);

  const reading = useRef<boolean>(false);
  const [readingNow, setReadingNow] = useState(false);
  // the button disappears with the error, so whether it held the focus has to be read before the answer is drawn
  const retryRead = useRef<number | null>(null);
  const focusSwitchOnDraw = useRef(false);

  const load = useCallback(() => {
    latestRead.current += 1;
    const read = latestRead.current;
    reading.current = true;
    setReadingNow(true);
    calls
      .read()
      .then((answer) => {
        if (read === latestRead.current) {
          focusSwitchOnDraw.current =
            retryRead.current === read &&
            retryButton.current !== null &&
            document.activeElement === retryButton.current;
          setLoadError(null);
          setPreference(answer);
        }
      })
      .catch((error: unknown) => {
        if (read === latestRead.current) {
          setLoadError(calls.readRefusal(error));
        }
      })
      .finally(() => {
        if (read === latestRead.current) {
          reading.current = false;
          setReadingNow(false);
        }
      });
  }, [calls, retryButton]);

  useEffect(() => {
    load();
    return () => {
      latestRead.current += 1;
      reading.current = false;
    };
  }, [load]);

  // a second touch lands before React draws the busy state
  const retry = useCallback(() => {
    if (!reading.current) {
      load();
      retryRead.current = latestRead.current;
    }
  }, [load]);

  const choose = useCallback(
    (on: boolean) => {
      if (savingRef.current) {
        return;
      }
      savingRef.current = true;
      latestRead.current += 1;
      setSaving(true);
      setOutcome(null);
      calls
        .setTips(on)
        .then((answer) => {
          setPreference(answer);
          setOutcome("saved");
        })
        .catch(() => setOutcome("failed"))
        .finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
    },
    [calls]
  );

  return {
    choose,
    focusSwitchOnDraw,
    loadError,
    outcome,
    preference,
    readingNow,
    retry,
    saving,
  };
}

/**
 * "E-mails que você recebe" in Seus dados (ADR 0106, D8): the tips series is the one preference the person turns on
 * and off, and it is the same one the link of the e-mail turns off, for every store of theirs. The account and billing
 * notices are listed with no control, because they are part of the service. A touch on the switch saves at once.
 */
export function EmailPreferenceCard({
  calls,
  online,
}: {
  calls: EmailPreferenceCalls;
  online: boolean;
}) {
  const retryButton = useRef<HTMLButtonElement>(null);
  const tipsSwitch = useRef<HTMLButtonElement>(null);
  const {
    choose,
    focusSwitchOnDraw,
    loadError,
    outcome,
    preference,
    readingNow,
    retry,
    saving,
  } = useEmailPreference(calls, retryButton);

  useEffect(() => {
    if (preference && focusSwitchOnDraw.current) {
      focusSwitchOnDraw.current = false;
      tipsSwitch.current?.focus();
    }
  }, [focusSwitchOnDraw, preference]);

  const handleRetry = useCallback(() => {
    if (online) {
      retry();
    }
  }, [online, retry]);

  const handleChange = useCallback(
    (checked: boolean) => {
      if (online) {
        choose(checked);
      }
    },
    [choose, online]
  );

  return (
    <Block aria-labelledby={TITLE_ID}>
      <BlockHeader id={TITLE_ID} level={3} title="E-mails que você recebe" />
      <BlockPanel>
        <div className="grid gap-1">
          <p className="font-medium">{NOTICES_LABEL}</p>
          <p className="text-muted-foreground">{NOTICES_HELP}</p>
        </div>
        <Separator />
        {preference ? (
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <Label className="font-medium" htmlFor={TIPS_ID}>
                {TIPS_LABEL}
              </Label>
              <p className="text-muted-foreground" id={TIPS_HELP_ID}>
                {TIPS_HELP}
              </p>
            </div>
            <Switch
              aria-busy={saving}
              checked={preference.tips}
              id={TIPS_ID}
              onCheckedChange={handleChange}
              ref={tipsSwitch}
              {...describedBy(online)}
            />
          </div>
        ) : null}
        {preference || loadError ? null : <Skeleton className="h-10 w-full" />}
        {loadError ? (
          <div className="grid justify-items-start gap-2">
            <FieldError>{loadError}</FieldError>
            <Button
              aria-busy={readingNow}
              onClick={handleRetry}
              ref={retryButton}
              size="sm"
              type="button"
              variant="outline"
              {...connectionControlProps(online)}
            >
              Tentar novamente
            </Button>
          </div>
        ) : null}
        {preference && preference.sent > 0 ? (
          <p className="text-muted-foreground">
            Enviados até agora: {preference.sent} de 3.
          </p>
        ) : null}
        <div className="empty:-mt-(--card-spacing)" role="status">
          {outcome === "saved" ? (
            <p className="text-muted-foreground">{SAVED_TEXT}</p>
          ) : null}
        </div>
        {outcome === "failed" ? (
          <FieldError>{SAVE_FAILED_TEXT}</FieldError>
        ) : null}
      </BlockPanel>
    </Block>
  );
}
