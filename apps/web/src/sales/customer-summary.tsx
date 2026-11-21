import type { CustomerReadModel } from "@polaris/contracts";
import type { ReactNode } from "react";
import { Money } from "@/ui/money";
import { lastPurchaseValueText } from "../customers/last-purchase";
import { useCurrentOrganization } from "../lib/current-organization";
import { formatBrlAmount } from "../lib/format";
import { useStoreToday } from "../lib/use-store-today";
import type { LinkPanelState } from "./sale-customer-link-model";

type Summary = NonNullable<CustomerReadModel["summary"]>;

function Indicator({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-0.5 @min-[20rem]:px-3 @min-[20rem]:py-0 py-2 first:pt-0 @min-[20rem]:first:pl-0 @min-[20rem]:last:pr-0 last:pb-0">
      <dt className="text-muted-foreground text-support">{label}</dt>
      <dd className="font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * What the customer bought: the count, the total and the last day, from the same read that named the customer. The
 * total is the amount owed by those sales, as the history shows it. The day is told from the store's today.
 */
export function CustomerSummary({ summary }: { summary: Summary }) {
  const { organization } = useCurrentOrganization();
  const today = useStoreToday(organization.timezone);
  if (summary.purchaseCount === 0 || summary.lastPurchaseOn === null) {
    return (
      <p
        className="text-muted-foreground text-support"
        data-customer-summary=""
      >
        Ainda sem compras.
      </p>
    );
  }
  return (
    <div className="@container" data-customer-summary="">
      <dl className="grid @min-[20rem]:grid-cols-3 @min-[20rem]:divide-x divide-y @min-[20rem]:divide-y-0 divide-border">
        <Indicator label="Compras">{summary.purchaseCount}</Indicator>
        <Indicator label="Total gasto">
          <Money size="md" text={formatBrlAmount(summary.totalSpent)} />
        </Indicator>
        <Indicator label="Última compra">
          {lastPurchaseValueText(summary.lastPurchaseOn, today)}
        </Indicator>
      </dl>
    </div>
  );
}

interface CurrentCustomerSummaryProps {
  customerId: string | null;
  load: LinkPanelState["currentCustomer"];
}

/**
 * The summary of the sale's current customer, once that customer was read alone: nothing while it is read (the block
 * comes in once, it pushes no form), when the read failed, when the answer has no summary (an older server) or when the
 * customer was anonymized.
 */
export function CurrentCustomerSummary({
  customerId,
  load,
}: CurrentCustomerSummaryProps) {
  if (
    load.status !== "ready" ||
    load.customerId !== customerId ||
    load.value.anonymizedAt !== null ||
    load.value.summary === undefined
  ) {
    return null;
  }
  return <CustomerSummary summary={load.value.summary} />;
}
