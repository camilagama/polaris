export type EnvironmentKind = "production" | "staging" | "unknown";

/**
 * The environment banner of the menu, written by the Worker into the page and again by the script on Configurações:
 * one table, imported by both, so the two cannot drift apart.
 */
export const ENVIRONMENT_BANNER: Readonly<Record<EnvironmentKind, string>> = {
  production: "PRODUÇÃO · dados reais",
  staging: "STAGING · dados de teste",
  unknown: "Ambiente não informado",
};
