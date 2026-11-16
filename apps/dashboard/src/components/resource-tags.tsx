import { Children, Fragment, type ReactNode } from "react";

/** Preserve a tag group's identity when RSC transports it to the client row. */
export function ResourceTags({ children }: { children: ReactNode }) {
  return <Fragment key="tags">{Children.toArray(children)}</Fragment>;
}
