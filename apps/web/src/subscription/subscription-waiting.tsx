import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button, buttonVariants } from "@/ui/button";
import { CardContent } from "@/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";

/** The Pix authorization just made: the "copia e cola" and Woovi's page, when it gave one (no QR, R-4). */
export interface PixHandoff {
  emv: string;
  url: string | null;
}

function PageLink({ className, url }: { className: string; url: string }) {
  return (
    <a
      className={className}
      href={url}
      rel="noopener noreferrer"
      target="_blank"
    >
      Abrir a página de pagamento
    </a>
  );
}

/**
 * Waiting for the bank's approval (AS-16): the code with "Copiar" and the page of Woovi. On the phone the code comes
 * first and the page is the second button; on the desktop the page, which shows the QR, is the main one. Making the
 * code does not start the trial: the screen reads the plan again until the approval arrives.
 */
export function PixWaiting({
  handoff,
  onChooseAgain,
  waitedOut,
  onReread,
}: {
  handoff: PixHandoff;
  onChooseAgain: () => void;
  onReread: () => void;
  waitedOut: boolean;
}) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const copy = useCallback(() => {
    // without the clipboard (an http page, an old browser) the person selects the code
    if (navigator.clipboard === undefined) {
      setCopied("failed");
      return;
    }
    navigator.clipboard
      .writeText(handoff.emv)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("failed"));
  }, [handoff.emv]);
  const code = (
    <Field className="order-1 md:order-2">
      <FieldLabel htmlFor="subscription-pix-code">
        Código Pix (copia e cola)
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          aria-describedby="subscription-pix-code-hint"
          className="min-w-0 flex-1"
          id="subscription-pix-code"
          readOnly
          value={handoff.emv}
        />
        <Button onClick={copy} type="button" variant="outline">
          Copiar
        </Button>
      </div>
      <FieldDescription id="subscription-pix-code-hint">
        No app do banco: Pix › Pix Automático › colar o código.
      </FieldDescription>
      <p className="m-0 text-support" role="status">
        {copied === "copied" ? "Código copiado." : null}
        {copied === "failed"
          ? "Não foi possível copiar. Selecione o código e copie."
          : null}
      </p>
    </Field>
  );
  return (
    <CardContent className="grid gap-3 border-t pt-(--card-spacing)">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 font-medium text-sm">Pix Automático</h3>
        <Badge variant="warning">Aguardando a aprovação no app do banco</Badge>
      </div>
      <p className="m-0 text-muted-foreground text-support">
        Autorize uma vez. O teste começa quando o banco confirmar; gerar o
        código não inicia o teste.
      </p>
      <div className="grid gap-3">
        {code}
        {handoff.url ? (
          <div className="order-2 grid justify-items-start gap-1 md:order-1">
            <PageLink
              className={cn(
                buttonVariants({ variant: "outline" }),
                "md:hidden"
              )}
              url={handoff.url}
            />
            <PageLink
              className={cn(
                buttonVariants({ variant: "default" }),
                "hidden md:inline-flex"
              )}
              url={handoff.url}
            />
            <p className="m-0 text-muted-foreground text-support">
              A página mostra o QR para ler com o celular. No celular, use o
              código.
            </p>
          </div>
        ) : null}
      </div>
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

/**
 * The screen reads the plan again by itself for 2 minutes; after that it says so and offers "Atualizar" (T-1). Never
 * a promise of time.
 */
export function WaitingLine({
  onReread,
  text,
  waitedOut,
}: {
  onReread: () => void;
  text: string;
  waitedOut: boolean;
}) {
  return waitedOut ? (
    <div className="grid justify-items-start gap-2">
      <p className="m-0 text-muted-foreground text-support">
        Ainda não recebemos a confirmação. Ela pode demorar alguns minutos.
      </p>
      <Button onClick={onReread} size="sm" type="button" variant="outline">
        Atualizar
      </Button>
    </div>
  ) : (
    <p className="m-0 text-muted-foreground text-support">{text}</p>
  );
}

/** Back from the card's page with success: the fact of the provider is on its way (AS-15). */
export function CardConfirming({
  onReread,
  waitedOut,
}: {
  onReread: () => void;
  waitedOut: boolean;
}) {
  return (
    <CardContent className="grid gap-2 border-t pt-(--card-spacing)">
      <p className="m-0 font-medium" role="status">
        Confirmando o pagamento…
      </p>
      <p className="m-0 text-muted-foreground text-support">
        Se demorar, pode fechar: avisamos por e-mail quando confirmar.
      </p>
      {waitedOut ? (
        <WaitingLine onReread={onReread} text="" waitedOut />
      ) : (
        <div>
          <Button onClick={onReread} size="sm" type="button" variant="outline">
            Atualizar
          </Button>
        </div>
      )}
    </CardContent>
  );
}
