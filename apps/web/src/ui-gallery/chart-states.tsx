import { formatBrlAmount } from "@/lib/format";
import {
  type ChartDatum,
  OnDemandAreaChart,
  OnDemandSparkline,
} from "@/ui/charts/on-demand";

/**
 * The two charts of src/ui/charts/ in the states the browser checks measure (t285): empty, one point, all zero,
 * constant and a series of thirty days, plus the week with a best day. They come through the on-demand loader, as
 * a screen draws them, so the gallery opens the charts chunk like the app will. Synthetic data only.
 */
const FIRST_DAY = Date.UTC(2026, 8, 24);
const DAY = 86_400_000;

const dayLabel = (offset: number) => {
  const date = new Date(FIRST_DAY + offset * DAY);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
};

const series = (values: readonly number[], first = 0): ChartDatum[] =>
  values.map((value, index) => ({ label: dayLabel(first + index), value }));

const WEEK = series([420.5, 1180, 90, 1840.9, 760, 0, 520], 23);
const MONTH = series(
  Array.from({ length: 30 }, (_, index) =>
    index % 9 === 4 ? 0 : 300 + ((index * 37) % 17) * 95
  )
);
const ONE_POINT = series([740], 29);
const ZEROS = series([0, 0, 0, 0, 0, 0, 0], 23);
const FLAT = series([500, 500, 500, 500, 500, 500, 500], 23);

const money = (value: number) => formatBrlAmount(value.toFixed(2));

/** "1,5 mil" and the bare figure, with no "R$" (the reading line above the chart has the unit); the gallery's own, the screens write theirs. */
function axisMoney(value: number) {
  if (value >= 1000) {
    return `${String(value / 1000).replace(".", ",")} mil`;
  }
  return String(value).replace(".", ",");
}

const SPARK_WEEK = WEEK.map((day) => day.value);
const SPARK_MONTH = MONTH.map((day) => day.value);

interface State {
  data: ChartDatum[];
  height: number;
  label: string;
  name: string;
}

const STATES: State[] = [
  {
    data: WEEK,
    height: 180,
    label: "Vendas líquidas por dia, de 17/10 a 23/10, dados de exemplo",
    name: "Série de 7 dias",
  },
  {
    data: MONTH,
    height: 220,
    label: "Vendas líquidas por dia, de 24/09 a 23/10, dados de exemplo",
    name: "Série de 30 dias",
  },
  {
    data: [],
    height: 180,
    label: "Vendas líquidas por dia, sem dados",
    name: "Vazio",
  },
  {
    data: ONE_POINT,
    height: 180,
    label: "Vendas líquidas, um dia: 23/10, R$ 740,00",
    name: "Um ponto",
  },
  {
    data: ZEROS,
    height: 180,
    label:
      "Vendas líquidas por dia, de 17/10 a 23/10, todos os dias com R$ 0,00",
    name: "Tudo zero",
  },
  {
    data: FLAT,
    height: 180,
    label: "Vendas líquidas por dia, de 17/10 a 23/10, R$ 500,00 todos os dias",
    name: "Constante",
  },
];

const SPARKS = [
  { name: "7 dias", values: SPARK_WEEK },
  { name: "30 dias", values: SPARK_MONTH },
  { name: "Vazio", values: [] },
  { name: "Um ponto", values: [740] },
  { name: "Tudo zero", values: [0, 0, 0, 0, 0, 0, 0] },
  { name: "Constante", values: [500, 500, 500, 500, 500, 500, 500] },
];

export function ChartStates() {
  return (
    <>
      <section
        aria-label="Gráficos de área"
        className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/[0.06]"
      >
        <h2 className="text-section">Gráficos de área</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          {STATES.map((state) => (
            <div className="grid min-w-0 content-start gap-2" key={state.name}>
              <h3 className="font-medium text-sm">{state.name}</h3>
              <OnDemandAreaChart
                data={state.data}
                failed={<p className="text-support">O gráfico não abriu.</p>}
                formatAxis={axisMoney}
                formatValue={money}
                height={state.height}
                label={state.label}
                rangeLabel={`Dia, ${state.name.toLowerCase()}`}
              />
            </div>
          ))}
        </div>
      </section>

      <section
        aria-label="Miniaturas"
        className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/[0.06]"
      >
        <h2 className="text-section">Miniaturas</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SPARKS.map((spark) => (
            <div className="grid min-w-0 gap-1" key={spark.name}>
              <p className="text-muted-foreground text-support">{spark.name}</p>
              <OnDemandSparkline values={spark.values} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
