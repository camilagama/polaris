import { useEffect, useState } from "react";
import type { Period } from "../dashboard/result-period";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import type { PeriodTotalRead } from "./sale-history-model";

interface Answer {
  key: string;
  result: Exclude<PeriodTotalRead, { status: "idle" | "loading" }>;
}

/**
 * Answers are keyed to the read they answer: a late answer for an older period never takes the place of the current
 * one.
 */
export function useHistoryPeriodTotal(
  organizationId: string,
  period: Period | null,
  reloadVersion: number
): PeriodTotalRead {
  const from = period?.from ?? "";
  const to = period?.to ?? "";
  const wanted =
    period === null ? null : `${organizationId}|${from}|${to}|${reloadVersion}`;
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (wanted === null) {
      setAnswer(null);
      return;
    }
    let current = true;
    readWithRetry(
      (signal) =>
        orpcClient.report.periodSummary(
          { from, organizationId, to },
          { signal }
        ),
      { isCurrent: () => current }
    )
      .then((summary) => {
        if (!current) {
          return;
        }
        const { netSales, salesCount } = summary.cards;
        if (typeof netSales !== "string" || typeof salesCount !== "number") {
          throw new Error("period_summary_malformed");
        }
        setAnswer({
          key: wanted,
          result: { netSales, salesCount, status: "ready" },
        });
      })
      .catch(() => {
        if (current) {
          setAnswer({ key: wanted, result: { status: "failed" } });
        }
      });
    return () => {
      current = false;
    };
  }, [from, organizationId, to, wanted]);

  if (wanted === null) {
    return { status: "idle" };
  }
  return answer?.key === wanted ? answer.result : { status: "loading" };
}
