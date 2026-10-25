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

const GROUP_OF_THREE = /\B(?=(\d{3})+(?!\d))/g;
const grouped = (value: number) =>
  String(Math.round(value)).replace(GROUP_OF_THREE, ".");

/** A figure of the axis in pt-BR with at most two decimals: 1,25 and not 1.25, 2 and not 2,00. */
const decimal = (value: number) =>
  String(Math.round(value * 100) / 100).replace(".", ",");

/**
 * A value of the y axis with no unit (the screen passes `axisUnit="R$"`, which goes only on the top line): below
 * 10 mil the whole number ("500", "1.250", "2.000"), from there "12,5 mil" and from a million "1 mi". The gallery's
 * own: the screens write theirs.
 */
function axisMoney(value: number) {
  if (value >= 999_950) {
    return `${decimal(value / 1_000_000)} mi`;
  }
  if (value >= 9999.5) {
    return `${decimal(value / 1000)} mil`;
  }
  if (value >= 1000) {
    return grouped(value);
  }
  return decimal(value);
}

const SPARK_WEEK = WEEK.map((day) => day.value);
const SPARK_MONTH = MONTH.map((day) => day.value);

interface State {
  data: ChartDatum[];
  height: number;
  label: string;
  loading?: boolean;
  name: string;
  secondary?: { data: ChartDatum[]; legend: string; name: string };
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

STATES.push(
  {
    data: WEEK,
    height: 180,
    label: "Vendas líquidas por dia, de 17/10 a 23/10, carregando",
    loading: true,
    name: "Carregando",
  },
  {
    data: WEEK,
    height: 220,
    label: "Vendas e custos por dia, de 17/10 a 23/10, dados de exemplo",
    name: "Duas séries",
    secondary: {
      data: WEEK.map((day) => ({ ...day, value: day.value * 0.6 })),
      legend: "Custos (CMV, taxas e despesas)",
      name: "Custos",
    },
  }
);

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
                axisUnit="R$"
                formatAxis={axisMoney}
                formatValue={money}
                height={state.height}
                label={state.label}
                loading={state.loading ?? false}
                loadingLabel={state.loading ? "Carregando" : undefined}
                {...(state.secondary ? { secondary: state.secondary } : {})}
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
