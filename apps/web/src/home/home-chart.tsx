import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { useCallback } from "react";
import { Button } from "@/ui/button";
import { OnDemandAreaChart } from "@/ui/charts/on-demand";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { MoneyText } from "@/ui/hidden-values";
import { useConnectionOnline } from "../lib/browser-connection";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useIsMobile } from "../lib/use-mobile";
import {
  addDays,
  bestDay,
  bestDayText,
  chartValue,
  lastDays,
  shortDate,
  sumNetSales,
} from "./home-model";
import { HomeBlock } from "./home-parts";
import type { HomeFigures } from "./use-home";

/**
 * The chart of net sales by day, 7 days open by default or 30 (AC-17, AC-18, AC-21, § 6): the total and the best day
 * written above it, the area chart of the charts chunk, and "Ver os números" with the table of every day, which is the
 * proof that the drawing hides nothing. A period with no sale says so instead of a drawing on the floor. When the
 * chunk does not open the numbers stay, and the sentence of § 5.5 says why.
 */

const GROUP_OF_THREE = /\B(?=(\d{3})+(?!\d))/g;

/** A value of the y axis with no unit (the unit goes once, on the top line): "500", "1.250", "12,5 mil", "1 mi". */
function axisMoney(value: number): string {
  const decimal = (amount: number) =>
    String(Math.round(amount * 100) / 100).replace(".", ",");
  if (value >= 999_950) {
    return `${decimal(value / 1_000_000)} mi`;
  }
  if (value >= 9999.5) {
    return `${decimal(value / 1000)} mil`;
  }
  return value >= 1000
    ? String(Math.round(value)).replace(GROUP_OF_THREE, ".")
    : decimal(value);
}

/** The exact text of a day, for the reading of the chart: the drawing has the value only as a number. */
function moneyText(value: number): string {
  return formatBrlAmount((Math.round(value * 100) / 100).toFixed(2));
}

const maskedValue = () => MASKED_MONEY;
const spokenMasked = () => MASKED_SPOKEN;
const noAxis = () => "";

/** The Início has no form: loading the page again is the way to ask for the chunk once more. */
function reloadPage() {
  window.location.reload();
}

export function ChartFailed() {
  const online = useConnectionOnline();
  return online ? (
    <div className="grid justify-items-start gap-2">
      <p className="text-muted-foreground text-support">O gráfico não abriu.</p>
      <Button onClick={reloadPage} size="sm" type="button" variant="outline">
        Tentar novamente
      </Button>
    </div>
  ) : (
    <p className="text-muted-foreground text-support">
      O gráfico abre quando a internet voltar. Os números estão acima.
    </p>
  );
}

/**
 * The days before the period, as many as it has (the "7 dias antes" of the week): only when the series read has them
 * all. The 30 days before 30 days are not read today (B starts 29 days before today at most), so the 30 days have no
 * comparison until the reading of the heat map brings them.
 */
function comparison(figures: HomeFigures, days: 7 | 30) {
  if (days !== 7) {
    return null;
  }
  const before = figures.before.daily ?? [];
  const month = figures.month.daily ?? [];
  const known = new Set([...before, ...month].map((day) => day.date));
  const earlier = lastDays(before, month, addDays(figures.today, -days), days);
  return earlier.every((day) => known.has(day.date)) ? earlier : null;
}

type Series = ReturnType<typeof lastDays>;

const points = (series: Series) =>
  series.map((day) => ({
    label: shortDate(day.date),
    value: chartValue(day.netSales),
  }));

/**
 * The area of the period, in the green of the sales (v7 § 4): a ring on every day of the week (full when it sold,
 * hollow on a zero) or on the best day and today of the 30, their values written above them, and the days before in
 * dashed grey with the legend when they were read. With the values hidden the amounts, the axis and the spoken values
 * are masked; the shape stays.
 */
function DayChart({
  days,
  earlier,
  series,
  summary,
}: {
  days: 7 | 30;
  earlier: Series | null;
  series: Series;
  summary: string;
}) {
  const [hidden] = useHiddenValues();
  const still = useIsMobile();
  return (
    <OnDemandAreaChart
      color="var(--chart-sales)"
      data={points(series)}
      failed={<ChartFailed />}
      formatAxis={hidden ? noAxis : axisMoney}
      formatSpoken={hidden ? spokenMasked : moneyText}
      formatValue={hidden ? maskedValue : moneyText}
      height={days === 7 ? 180 : 220}
      label={hidden ? maskMoney(summary, MASKED_SPOKEN) : summary}
      legend="Vendas líquidas"
      markers={days === 7 ? "all" : "key"}
      name="Vendas"
      rangeLabel={`Dia, últimos ${days} dias`}
      still={still}
      valueLabels
      {...(hidden ? {} : { axisUnit: "R$" })}
      {...(earlier
        ? {
            secondary: {
              color: "var(--chart-context)",
              data: points(earlier),
              legend: `${days} dias antes`,
              name: `${days} dias antes`,
            },
          }
        : {})}
    />
  );
}

function Period({ days, figures }: { days: 7 | 30; figures: HomeFigures }) {
  const series = lastDays(
    figures.before.daily ?? [],
    figures.month.daily ?? [],
    figures.today,
    days
  );
  const earlier = comparison(figures, days);
  const total = sumNetSales(series);
  const best = bestDay(series);
  // a period of returns only (net below zero) still has a drawing: "Sem vendas" is for a period with nothing
  const sold = series.some((day) => chartValue(day.netSales) !== 0);
  const range = `de ${shortDate(series[0]?.date ?? figures.today)} a ${shortDate(figures.today)}`;
  const summary = `Vendas líquidas por dia, ${range}: ${formatBrlAmount(total)} no total`;
  return (
    <div className="grid gap-3">
      <p className="grid gap-0.5">
        <span className="font-semibold text-lg tabular-nums">
          <MoneyText text={formatBrlAmount(total)} />
        </span>
        <span className="text-muted-foreground text-support">
          {`Vendas líquidas ${range}`}
        </span>
        {best ? (
          <span className="flex items-center gap-1.5 text-support">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-chart-sales"
            />
            <span>
              <MoneyText text={bestDayText(series) ?? ""} />
            </span>
          </span>
        ) : null}
      </p>
      {sold ? (
        <DayChart
          days={days}
          earlier={earlier}
          series={series}
          summary={summary}
        />
      ) : (
        <p className="text-muted-foreground">Sem vendas no período.</p>
      )}
      {/* the table of the other period opens closed, as it did with a panel for each period */}
      <Collapsible key={days}>
        <CollapsibleTrigger
          className="group/numbers w-fit"
          render={<Button size="sm" variant="ghost" />}
        >
          Ver os números
          <ChevronDownIcon
            aria-hidden="true"
            className="motion-full:transition-transform group-data-[panel-open]/numbers:rotate-180"
            data-icon="inline-end"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel className="pt-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Dia</TableHead>
                <TableHead className="text-right" scope="col">
                  Vendas líquidas
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((day) => (
                <TableRow key={day.date}>
                  <TableCell>{formatCalendarDate(day.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <MoneyText text={formatBrlAmount(day.netSales)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** The tab of the chart: the page keeps it, so it outlasts the connection going and coming back. */
export type ChartDays = "7" | "30";

export function ChartBlock({
  days,
  figures,
  onDays,
}: {
  days: ChartDays;
  figures: HomeFigures;
  onDays: (days: ChartDays) => void;
}) {
  const choose = useCallback(
    (value: unknown) => onDays(value === "30" ? "30" : "7"),
    [onDays]
  );
  return (
    <HomeBlock
      className="lg:col-start-1 lg:row-start-2"
      id="home-chart"
      title="Vendas por dia"
    >
      <Tabs onValueChange={choose} value={days}>
        <TabsList aria-label="Período do gráfico">
          <TabsTrigger value="7">7 dias</TabsTrigger>
          <TabsTrigger value="30">30 dias</TabsTrigger>
        </TabsList>
        {/* one panel for both periods, so the chart is the same instance when the tab changes: no new reveal of a chart
            that mounted again (the data change at once and the y axis tweens, 500 ms) */}
        <TabsContent value={days}>
          <Period days={days === "30" ? 30 : 7} figures={figures} />
        </TabsContent>
      </Tabs>
    </HomeBlock>
  );
}
