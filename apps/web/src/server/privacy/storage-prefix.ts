import type { MediaBucketBinding } from "../environment";

const LIST_PAGE = 1000;

/**
 * Removes every object under a prefix, page by page, and returns how many it removed. Removing again
 * what is already gone has no effect, so a run that stopped in the middle can simply run again. Used
 * for one export (`exports/v1/{organization}/{export}/`) and for the purge of a whole organization
 * (its exports and its image masters, ADR 0078 and 0081).
 */
export async function deleteObjectsUnderPrefix(
  bucket: Pick<MediaBucketBinding, "delete" | "list">,
  prefix: string
): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the cursor of the one before.
    const page = await bucket.list({
      ...(cursor === undefined ? {} : { cursor }),
      limit: LIST_PAGE,
      prefix,
    });
    for (const object of page.objects) {
      // biome-ignore lint/performance/noAwaitInLoops: one object at a time keeps the run's external calls bounded.
      await bucket.delete(object.key);
      removed += 1;
    }
    if (!(page.truncated && page.cursor)) {
      return removed;
    }
    ({ cursor } = page);
  }
}
