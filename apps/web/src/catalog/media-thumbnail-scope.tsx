import type { ReactNode } from "react";
import { useOrganizationLoad } from "../lib/current-organization";
import { MediaThumbsFlagProvider } from "../lib/media-thumbs-flag";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import { ThumbnailProvider } from "./product-thumbnail";

/**
 * The thumbnails of the store the page is in, for every list below the shell. The loader (and the disk cache of the
 * device's namespace) exists only while the server says `mediaThumbs` is on; off, the rows draw what they drew before
 * and nothing is asked. The namespace is the one the offline copy of this store uses, so the cache leaves with it.
 */
export function MediaThumbnailScope({
  children,
  organizationId,
}: {
  children: ReactNode;
  organizationId: string;
}) {
  const { mediaThumbs } = useOrganizationLoad();
  const runtime = useOfflineRuntime();
  // the namespace opens and closes with the runtime: render again when it does
  useRuntimeSnapshot();
  return (
    <MediaThumbsFlagProvider value={mediaThumbs}>
      <ThumbnailProvider
        enabled={mediaThumbs}
        namespaceKey={runtime?.namespaceKey(organizationId) ?? null}
        organizationId={organizationId}
      >
        {children}
      </ThumbnailProvider>
    </MediaThumbsFlagProvider>
  );
}
