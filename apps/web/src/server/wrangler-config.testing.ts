interface WranglerConfig {
  env?: Record<string, { vars?: Record<string, string> } | undefined>;
  vars?: Record<string, string>;
}

/** wrangler.jsonc is JSON with comments and trailing commas, which is also a valid JavaScript expression. */
export function parseWranglerConfig(text: string): WranglerConfig {
  return new Function(`return (${text}\n);`)() as WranglerConfig;
}

/** The `vars` of the top level (`undefined`) or of a named environment, wherever its block sits in the file. */
export function varsOf(
  config: WranglerConfig,
  environment?: string
): Record<string, string> {
  return (environment ? config.env?.[environment]?.vars : config.vars) ?? {};
}

/** Every key and every string value of the parsed config, at any depth. */
export function namesAndValuesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(namesAndValuesOf);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...namesAndValuesOf(item),
    ]);
  }
  return [];
}
