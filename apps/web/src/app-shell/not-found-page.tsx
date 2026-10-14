interface NotFoundPageProps {
  pathname: string;
}

/** Unknown addresses end here instead of silently opening another screen. */
export function NotFoundPage({ pathname }: NotFoundPageProps) {
  return (
    <section aria-labelledby="app-not-found-title" className="app-not-found">
      <p className="categories-eyebrow">Erro 404</p>
      <h1 id="app-not-found-title">Página não encontrada</h1>
      <p>
        O endereço <code>{pathname}</code> não existe no Polaris. Use o menu ou
        volte para uma das áreas abaixo.
      </p>
      <div className="app-actions">
        <a className="primary-button" href="/sales">
          Ir para Vender
        </a>
        <a className="quiet-button" href="/sales/history">
          Ver o histórico
        </a>
      </div>
    </section>
  );
}
