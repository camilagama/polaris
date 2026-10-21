export interface HeadersRule {
  lines: string[];
  path: string;
}
export function parseHeadersFile(text: string): HeadersRule[];
export function headersForPath(
  rules: HeadersRule[],
  pathname: string
): Record<string, string>;
