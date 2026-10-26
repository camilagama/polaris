import EyeIcon from "lucide-react/dist/esm/icons/eye";
import EyeOffIcon from "lucide-react/dist/esm/icons/eye-off";
import { useCallback } from "react";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  moneyParts,
  useHiddenValues,
} from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * "Esconder valores" (revisão de UI v7, § 6): the toggle (`aria-pressed`) and the text whose amounts it hides. The
 * name of the button stays "Esconder valores" in both states, as a toggle's name does, and the pressed state says
 * whether they are hidden; the eye changes with it. Below 760 px it is an icon button (36 px, or the small size beside small buttons) with a 48 px touch area.
 */
export function HideValuesButton({
  className,
  size = "default",
}: {
  className?: string;
  size?: "default" | "sm";
}) {
  const [hidden, setHidden] = useHiddenValues();
  const Icon = hidden ? EyeOffIcon : EyeIcon;
  const toggle = useCallback(() => setHidden(!hidden), [hidden, setHidden]);
  return (
    <Button
      aria-pressed={hidden}
      className={cn(
        "aria-pressed:bg-accent max-md:px-0",
        size === "sm" ? "max-md:size-ctl-sm" : "max-md:size-ctl-lg",
        className
      )}
      onClick={toggle}
      size={size}
      type="button"
      variant="outline"
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span className="max-md:sr-only">Esconder valores</span>
    </Button>
  );
}

/** One amount hidden: seen as "R$ ••••", heard as "valor escondido". */
export function MaskedMoney() {
  return (
    <>
      <span aria-hidden="true" data-masked-money="">
        {MASKED_MONEY}
      </span>
      <span className="sr-only">{MASKED_SPOKEN}</span>
    </>
  );
}

/**
 * A text that may carry amounts ("Melhor dia: 18/10, R$ 1.840,00"): as it is while the values show, and with each
 * amount masked while they are hidden (the rest of the words, the percents and the counts stay).
 */
export function MoneyText({ text }: { text: string }) {
  const [hidden] = useHiddenValues();
  if (!hidden) {
    return <>{text}</>;
  }
  return (
    <>
      {moneyParts(text).map((part, index) =>
        part.money ? <MaskedMoney key={index} /> : part.text
      )}
    </>
  );
}
