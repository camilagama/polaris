import { type PeriodQuality, qualityView } from "./dashboard-model";

/**
 * How complete the estimate is. Complete is a quiet line, partial is a warning
 * that names what was left out, and no data is an empty state. The tone is
 * always in the text, never only in the color.
 */
export function QualityBanner({ quality }: { quality: PeriodQuality }) {
  const view = qualityView(quality);
  return (
    <section
      aria-label="Qualidade dos dados"
      className={`dashboard-quality is-${view.tone}`}
    >
      <p className="dashboard-quality-title">{view.title}</p>
      {view.messages.length > 0 ? (
        <ul className="dashboard-quality-list">
          {view.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {view.tone === "partial" ? (
        <p className="dashboard-quality-note">
          O que não é conhecido fica de fora das contas, nunca entra como zero.
        </p>
      ) : null}
    </section>
  );
}
