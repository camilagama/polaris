import { type ComponentType, createElement, lazy } from "react";

/** A lazy screen that can be asked again: `reset` makes the next render call `import()` anew. */
export type LazyScreen<Props = Record<never, never>> = ComponentType<Props> & {
  reset: () => void;
};

/**
 * `React.lazy` keeps the promise of its first `import()`, rejected or not, so a screen whose chunk failed to
 * download fails again on every render. This keeps a lazy component that `reset` replaces by a new one, with a new
 * `import()`; the error boundary calls it on "Tentar novamente".
 */
export function lazyScreen<Props extends object = Record<never, never>>(
  load: () => Promise<{ default: ComponentType<Props> }>
): LazyScreen<Props> {
  let Inner = lazy(load);
  const Screen = ((props: Props) =>
    createElement(Inner as ComponentType<Props>, props)) as LazyScreen<Props>;
  Screen.reset = () => {
    Inner = lazy(load);
  };
  return Screen;
}
