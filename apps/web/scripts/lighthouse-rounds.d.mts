export const ROUNDS_PER_PAGE: number;
export const CONTENDED_BELOW: number;
export interface Round {
  benchmark: number;
  cls: number;
  file: string;
  js: number;
  lcp: number;
  tbt: number;
  url: string;
}
export function median(values: number[]): number;
export function roundOf(file: string, lhr: unknown): Round;
export function readRounds(directory: string): Round[];
export function contendedByPage(rounds: Round[]): Map<string, number>;
export function surplusFiles(rounds: Round[]): string[];
export function summaryTable(rounds: Round[]): string;
