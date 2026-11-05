import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { browserConnection } from "../lib/browser-connection";
import { timerSchedule } from "../lib/connection";
import { openThumbnailDisk, wipeThumbnails } from "../offline/thumbnail-store";
import { Thumbnail, type ThumbnailSize } from "@/ui/thumbnail";
import { productInitials } from "./product-search-model";
import { ThumbnailCache } from "./thumbnail-cache";
import { ThumbnailLoader } from "./thumbnail-queue";
import {
  createThumbnailTransport,
  type ThumbnailTransport,
} from "./thumbnail-transport";

/**
 * The capa of a product in a list: a box of fixed size whose base state is the marker (the product's two initials
 * on `bg-muted`), with the photo laid over it once its bytes are here. Every state (in the cache, no image, loading,
 * failed, offline with or without the cache) draws the same box in the same place, so a row never moves when the
 * photo arrives or does not. The photo is decoration: `alt=""`, inside an `aria-hidden` box, never focused.
 */
export type ProductThumbnailSize = ThumbnailSize;

/** How far outside the window a row already counts as on screen: about one row. */
const VISIBILITY_MARGIN = "48px 0px";

type Observe = (
  element: Element,
  onChange: (visible: boolean) => void
) => () => void;

interface ThumbnailContextValue {
  loader: ThumbnailLoader;
  observe: Observe;
}

const ThumbnailContext = createContext<ThumbnailContextValue | null>(null);

/**
 * One observer for every thumbnail under a provider, made on the first row that asks (never while rendering to a
 * string). After `dispose` the next row makes a new one. Without `IntersectionObserver`, every row counts as seen.
 */
function createObserve(): { dispose: () => void; observe: Observe } {
  const callbacks = new Map<Element, (visible: boolean) => void>();
  let observer: IntersectionObserver | null = null;
  const observing = () => {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          callbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      { rootMargin: VISIBILITY_MARGIN }
    );
    return observer;
  };
  return {
    dispose: () => {
      observer?.disconnect();
      observer = null;
      callbacks.clear();
    },
    observe: (element, onChange) => {
      if (typeof IntersectionObserver === "undefined") {
        onChange(true);
        return () => onChange(false);
      }
      callbacks.set(element, onChange);
      observing().observe(element);
      return () => {
        observer?.unobserve(element);
        callbacks.delete(element);
        onChange(false);
      };
    },
  };
}

/** Hands an already built loader to the thumbnails below (the gallery and the tests build their own). */
export function ThumbnailLoaderProvider({
  children,
  loader,
}: {
  children: ReactNode;
  /** `null` while there is none yet: the rows show the marker. */
  loader: ThumbnailLoader | null;
}) {
  const visibility = useMemo(() => createObserve(), []);
  useEffect(() => visibility.dispose, [visibility]);
  const value = useMemo(
    () => (loader ? { loader, observe: visibility.observe } : null),
    [loader, visibility]
  );
  return (
    <ThumbnailContext.Provider value={value}>
      {children}
    </ThumbnailContext.Provider>
  );
}

interface ThumbnailProviderProps {
  children: ReactNode;
  /**
   * `false` (the default is `true`) builds no loader and no cache and opens nothing on the disk: the rows below show
   * the marker and ask for nothing. The tree stays the same, so a screen is not remounted when this turns on.
   */
  enabled?: boolean;
  /**
   * The namespace (user + store) when this device keeps the offline copy of the store, `null` otherwise: the same
   * answer that decides whether the copy exists (`useLocalWorkspace`). With `null` nothing is written to the disk.
   */
  namespaceKey: string | null;
  organizationId: string;
  /** Stable across renders (a module constant): a new one builds a new loader. */
  transport?: ThumbnailTransport;
}

/**
 * The thumbnails of one store. Switching to another store lets go of everything of the previous one (its URLs in
 * memory and its database on the disk), so no capa of the previous store is ever shown in the next one.
 */
export function ThumbnailProvider({
  children,
  enabled = true,
  namespaceKey,
  organizationId,
  transport,
}: ThumbnailProviderProps) {
  const [goneKey, setGoneKey] = useState<string | null>(null);
  const [made, setMade] = useState<{
    key: string;
    loader: ThumbnailLoader;
  } | null>(null);
  const previous = useRef<{
    namespaceKey: string | null;
    organizationId: string;
  } | null>(null);
  // a database wiped under the open cache (logout, revocation) is not opened again for the same namespace
  const diskKey =
    namespaceKey && namespaceKey !== goneKey ? namespaceKey : null;
  const key = `${organizationId}|${diskKey ?? ""}`;

  useEffect(() => {
    // a namespace that comes back after it went away (the person signed in again) may use the disk again
    if (namespaceKey === null) {
      setGoneKey(null);
    }
  }, [namespaceKey]);

  useEffect(() => {
    const before = previous.current;
    previous.current = { namespaceKey, organizationId };
    const otherStore = before?.organizationId !== organizationId;
    const otherUser =
      Boolean(namespaceKey) && before?.namespaceKey !== namespaceKey;
    if (before?.namespaceKey && (otherStore || otherUser)) {
      wipeThumbnails(before.namespaceKey).catch(() => undefined);
    }
  }, [namespaceKey, organizationId]);

  useEffect(() => {
    if (!enabled) {
      setMade(null);
      return;
    }
    let live = true;
    const cache = new ThumbnailCache({
      disk: diskKey
        ? openThumbnailDisk(diskKey, () => {
            // only a wipe from outside counts: this provider's own switch already let go of the cache
            if (live) {
              setGoneKey(diskKey);
            }
          })
        : null,
      now: () => Date.now(),
    });
    const loader = new ThumbnailLoader({
      cache,
      isOnline: browserConnection.isOnline,
      organizationId,
      schedule: timerSchedule,
      subscribeOnline: browserConnection.subscribe,
      transport: transport ?? createThumbnailTransport(),
    });
    setMade({ key, loader });
    return () => {
      live = false;
      loader.dispose();
      cache.dispose();
    };
  }, [diskKey, enabled, key, organizationId, transport]);

  // the loader of the previous store is never handed down, not even for the one render before the effect runs
  return (
    <ThumbnailLoaderProvider loader={made?.key === key ? made.loader : null}>
      {children}
    </ThumbnailLoaderProvider>
  );
}

function useThumbnailUrl(
  context: ThumbnailContextValue | null,
  assetId: string | null | undefined
): string | null {
  const loader = context?.loader;
  const subscribe = useCallback(
    (listener: () => void) =>
      loader && assetId ? loader.subscribe(assetId, listener) : () => undefined,
    [loader, assetId]
  );
  return useSyncExternalStore(
    subscribe,
    () => (loader && assetId ? loader.url(assetId) : null),
    () => (loader && assetId ? loader.url(assetId) : null)
  );
}

/**
 * Tells the loader the order of the rows of the list now (their capa ids), so a batch started by a visible row is
 * completed with the rows after it. Nothing is asked here: only rows on screen start a request.
 */
export function useThumbnailSequence(
  assetIds: readonly (string | null | undefined)[]
): void {
  const loader = useContext(ThumbnailContext)?.loader;
  useEffect(() => {
    loader?.setSequence(assetIds);
  }, [loader, assetIds]);
}

export interface ProductThumbnailProps {
  /** The capa (`coverAssetId`); `null` or absent shows the marker and asks for nothing. */
  assetId: string | null | undefined;
  /** The product's name (not the variant's): its two initials are the marker. */
  name: string;
  size: ProductThumbnailSize;
}

export function ProductThumbnail({
  assetId,
  name,
  size,
}: ProductThumbnailProps) {
  const context = useContext(ThumbnailContext);
  const box = useRef<HTMLSpanElement>(null);
  const url = useThumbnailUrl(context, assetId);
  useEffect(() => {
    const element = box.current;
    if (!(context && assetId && element)) {
      return;
    }
    let hide: (() => void) | null = null;
    const stop = context.observe(element, (visible) => {
      if (visible && !hide) {
        hide = context.loader.show(assetId);
      } else if (!visible && hide) {
        hide();
        hide = null;
      }
    });
    return () => {
      stop();
      hide?.();
    };
  }, [context, assetId]);

  return (
    <Thumbnail marker={productInitials(name)} ref={box} size={size} src={url} />
  );
}
