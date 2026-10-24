import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
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
import { useConnectionOnline } from "../lib/browser-connection";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
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

/** The Início has no form: loading the page again is the way to ask for the chunk once more. */
function reloadPage() {
  window.location.reload();
}

function ChartFailed() {
  const online = useConnectionOnline();
  return online ? (
    <div className="grid justify-items-start gap-2">
      <p className="text-muted-foreground text-support">O gráfico não abriu.</p>
      <Button
        onClick={reloadPage}
        size="sm"
        type="button"
        variant="outline"
      >
        Tentar novamente
      </Button>
    </div>
  ) : (
    <p className="text-muted-foreground text-support">
      O gráfico abre quando a internet voltar. Os números estão acima.
    </p>
  );
}

function Period({ days, figures }: { days: 7 | 30; figures: HomeFigures }) {
  const series = lastDays(
    figures.before.daily ?? [],
    figures.month.daily ?? [],
    figures.today,
    days
  );
  const total = sumNetSales(series);
  const best = bestDay(series);
  const range = `de ${shortDate(series[0]?.date ?? figures.today)} a ${shortDate(figures.today)}`;
  return (
    <div className="grid gap-3">
      <p className="grid gap-0.5">
        <span className="font-semibold text-lg tabular-nums">
          {formatBrlAmount(total)}
        </span>
        <span className="text-muted-foreground text-support">
          {`Vendas líquidas ${range}`}
        </span>
        {best ? (
          <span className="text-support">{bestDayText(series)}</span>
        ) : null}
      </p>
      {best ? (
        <OnDemandAreaChart
          axisUnit="R$"
          data={series.map((day) => ({
            label: shortDate(day.date),
            value: chartValue(day.netSales),
          }))}
          failed={<ChartFailed />}
          formatAxis={axisMoney}
          formatValue={moneyText}
          height={days === 7 ? 180 : 220}
          label={`Vendas líquidas por dia, ${range}: ${formatBrlAmount(total)} no total; ${bestDayText(series)}`}
          rangeLabel={`Dia, últimos ${days} dias`}
        />
      ) : (
        <p className="text-muted-foreground">Sem vendas no período.</p>
      )}
      <Collapsible>
        <CollapsibleTrigger
          className="group/numbers w-fit"
          render={<Button size="sm" variant="ghost" />}
        >
          Ver os números
          <ChevronDownIcon
            aria-hidden="true"
            className="transition-transform group-data-[panel-open]/numbers:rotate-180"
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
                    {formatBrlAmount(day.netSales)}
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

export function ChartBlock({ figures }: { figures: HomeFigures }) {
  return (
    <HomeBlock
      className="lg:col-start-1 lg:row-start-2"
      id="home-chart"
      title="Vendas por dia"
    >
      <Tabs defaultValue="7">
        <TabsList aria-label="Período do gráfico">
          <TabsTrigger value="7">7 dias</TabsTrigger>
          <TabsTrigger value="30">30 dias</TabsTrigger>
        </TabsList>
        <TabsContent value="7">
          <Period days={7} figures={figures} />
        </TabsContent>
        <TabsContent value="30">
          <Period days={30} figures={figures} />
        </TabsContent>
      </Tabs>
    </HomeBlock>
  );
}
