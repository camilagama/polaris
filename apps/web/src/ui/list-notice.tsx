import type { ReactNode } from "react";
import { Card } from "./card";

/** The few words of a list that has nothing to show, and what to do next: the body both `ListNotice` and the `ListBlock` draw. */
export function ListNoticeBody({ children }: { children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 px-4 text-center">
      {children}
    </div>
  );
}

/** Loading, empty or no result of a list: a card with a few words, and what to do next when there is one. */
export function ListNotice({ children }: { children: ReactNode }) {
  return (
    <Card className="py-6">
      <ListNoticeBody>{children}</ListNoticeBody>
    </Card>
  );
}
