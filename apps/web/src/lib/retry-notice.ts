const RETRY_ASK = / Tente novamente\.$/;

/**
 * The sentence of a notice that has the `RetryButton` under it: the button is the way to try again, so the sentence
 * does not end by asking for it. Only that closing ask goes; a "tente novamente" inside the sentence says something
 * else (what to do first) and stays.
 */
export function withoutRetryAsk(sentence: string): string {
  return sentence.replace(RETRY_ASK, "");
}
