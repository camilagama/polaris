import {
  MAX_RATE_PERCENTAGE_POINTS,
  PERCENTAGE_SCALE,
  Percentage,
} from "@polaris/domain/money/money";

const TRAILING_ZEROS = /0+$/;
const TRAILING_DOT = /\.$/;
const SHOWN_DECIMALS = 2;
const SMALLEST_SHOWN = 0.005;
const percentFormat = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: SHOWN_DECIMALS,
  minimumFractionDigits: 0,
});

/** What the field says when the percentage cannot be a fee rate: the limit the server accepts, with an example (U-29). */
export const PERCENTAGE_RULE_TEXT = `Informe o percentual de 0 a ${MAX_RATE_PERCENTAGE_POINTS}, com até ${PERCENTAGE_SCALE} casas decimais, por exemplo 2,5.`;

/**
 * The same check the server runs on a fee percentage (nonnegative, at most 100, up to 6 decimals), before
 * anything is sent. Empty is a problem too: a percentage fee has to say the percentage.
 */
export function percentageProblem(text: string): string | null {
  const value = text.trim();
  if (value === "") {
    return PERCENTAGE_RULE_TEXT;
  }
  try {
    Percentage.fromRate(value);
    return null;
  } catch {
    return PERCENTAGE_RULE_TEXT;
  }
}

/**
 * A stored percentage as the list says it, in pt-BR, with at most two decimals and no trailing zeros: the
 * server keeps six ("3.000000"), the person reads "3%" and "2,5%". A value that is not a number is shown
 * as it came.
 */
export function formatFeePercentage(value: string): string {
  const number = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(number)) {
    return `${value}%`;
  }
  // a fee that is not zero never reads as "0%"
  if (number > 0 && number < SMALLEST_SHOWN) {
    return "<0,01%";
  }
  return `${percentFormat.format(number)}%`;
}

/**
 * A stored percentage as the field is filled when a profile is edited: without the trailing zeros the server
 * adds ("3.000000" becomes "3"), keeping every digit that means something so saving does not change the rate.
 */
export function percentageFieldText(value: string | null): string {
  if (value === null) {
    return "";
  }
  if (!value.includes(".")) {
    return value;
  }
  return value.replace(TRAILING_ZEROS, "").replace(TRAILING_DOT, "");
}
