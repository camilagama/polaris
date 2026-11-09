import EyeIcon from "lucide-react/dist/esm/icons/eye";
import EyeOffIcon from "lucide-react/dist/esm/icons/eye-off";
import { useCallback } from "react";
import { moneyParts, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Money } from "./money";

/**
 * "Esconder valores" (revisão de UI v7, § 6): the toggle (`aria-pressed`) and the text whose amounts it hides. The
 * name of the button stays "Esconder valores" in both states, as a toggle's name does, and the pressed state says
 * whether they are hidden; the eye changes with it. Below 760 px it is an icon button (36 px) with a 44 px touch area.
 * One size on every screen: the same action is the same button.
 */
export function HideValuesButton({ className }: { className?: string }) {
  const [hidden, setHidden] = useHiddenValues();
  const Icon = hidden ? EyeOffIcon : EyeIcon;
  const toggle = useCallback(() => setHidden(!hidden), [hidden, setHidden]);
  return (
    <Button
      aria-pressed={hidden}
      className={cn(
        "aria-pressed:bg-accent max-md:size-ctl-lg max-md:px-0",
        className
      )}
      onClick={toggle}
      type="button"
      variant="outline"
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span className="max-md:sr-only">Esconder valores</span>
    </Button>
  );
}

/**
 * A text with its amounts kept in one piece: "R$" and the number never fall on two lines, however large the font is.
 * The text is the same, only each amount sits in a box that does not break.
 */
export function NoBreakMoney({ text }: { text: string }) {
  return (
    <>
      {moneyParts(text).map((part, index) =>
        part.money ? <Money key={index} text={part.text} unmasked /> : part.text
      )}
    </>
  );
}

/**
 * A text that may carry amounts ("Melhor dia: 18/10, R$ 1.840,00"): as it is while the values show, and with each
 * amount masked while they are hidden (the rest of the words, the percents and the counts stay).
 */
export function MoneyText({ text }: { text: string }) {
  return (
    <>
      {moneyParts(text).map((part, index) =>
        part.money ? <Money key={index} text={part.text} /> : part.text
      )}
    </>
  );
}
