// Generated from packages/ui/src/theme.css. Do not edit.
// To generate again: bun run tokens:generate
// The page follows prefers-color-scheme (it runs no script to read the theme of the app), so the dark values are in a
// media query, not in .dark.

export const pageTokens = `
:root {
  --background: oklch(0.985 0.004 85);
  --foreground: oklch(0.2 0.005 85);
  --card: oklch(1 0 0);
  --muted-foreground: oklch(0.43 0.005 85);
  --secondary: oklch(0.962 0.005 85);
  --accent: oklch(0.945 0.006 85);
  --border: oklch(0.915 0.005 85);
  --input: oklch(0.64 0.005 85);
  --ring: oklch(0.585 0.115 165);
  --mark: oklch(0.6 0.125 165);
  --primary: oklch(0.2 0.005 85);
  --primary-foreground: oklch(1 0 0);
  --btn-shine: oklch(1 0 0 / 0.14);
  --btn-drop: oklch(0.28 0.012 85 / 0.2);
  --card-ring: oklch(0.2 0.005 85 / 0.06);
  --card-glow: oklch(1 0 0 / 0);
  --shadow-l: 0.28;
  --shadow-c: 0.012;
  --shadow-a: 1;
  --shadow-xs: 0 1px 2px 0 oklch(var(--shadow-l) var(--shadow-c) 85 / calc(0.05 * var(--shadow-a)));
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.2 0.0035 85);
    --foreground: oklch(0.945 0.005 85);
    --card: oklch(0.235 0.0035 85);
    --muted-foreground: oklch(0.79 0.004 85);
    --secondary: oklch(0.3 0.0035 85);
    --accent: oklch(0.33 0.0035 85);
    --border: oklch(1 0 0 / 0.06);
    --input: oklch(0.58 0.0035 85);
    --ring: oklch(0.64 0.134 165);
    --mark: oklch(0.74 0.14 165);
    --primary: oklch(0.93 0.005 85);
    --primary-foreground: oklch(0.2 0.0035 85);
    --btn-shine: oklch(1 0 0 / 0);
    --btn-drop: oklch(0 0 0 / 0.5);
    --card-ring: oklch(1 0 0 / 0.06);
    --card-glow: oklch(1 0 0 / 0.04);
    --shadow-l: 0;
    --shadow-c: 0;
    --shadow-a: 2.4;
  }
}
`;
