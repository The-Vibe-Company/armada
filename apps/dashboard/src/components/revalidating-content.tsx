"use client";

import { type ReactNode, useEffect, useState } from "react";

// Render identities only, never private content. A new server render is already fresh;
// encountering the same identity again means Next restored a cached section.
let activeScope: string | null = null;
const seen = new Map<string, string>();

export function RevalidatingContent({
  scope,
  path,
  renderId,
  refresh,
  children,
}: {
  scope: string;
  path: string;
  renderId: string;
  refresh: () => Promise<ReactNode>;
  children: ReactNode;
}) {
  const [content, setContent] = useState(children);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // React Strict Mode replays effects. Only a still-mounted effect records a visit.
    queueMicrotask(() => {
      if (cancelled) return;
      if (activeScope !== scope) {
        activeScope = scope;
        seen.clear();
      }
      const revisit = seen.get(path) === renderId;
      seen.set(path, renderId);
      if (!revisit) return;
      setFailed(false);
      void refresh().then(
        (next) => {
          if (!cancelled) setContent(next);
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [scope, path, renderId, refresh]);

  return (
    <>
      {failed && (
        <p role="status" className="text-sm text-muted-foreground">
          This view could not be refreshed.{" "}
          <a href={path} className="underline">
            Reload
          </a>{" "}
          to try again.
        </p>
      )}
      {content}
    </>
  );
}
