import type { ReactNode } from "react";

// A line of the diff (split-diff direction), the kit's one row: the gutter, the sign, the content.

/** One line of the diff: its number in the gutter, its sign, and what it holds. */
export function Line({
  kind,
  no,
  block = false,
  children,
}: {
  kind: "del" | "add";
  no: number;
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`dx-ln is-${kind}${block ? " is-block" : ""}`}>
      <span className="dx-no" aria-hidden>
        {no}
      </span>
      <span className="dx-mk" aria-hidden>
        {kind === "del" ? "−" : "+"}
      </span>
      <div className="dx-tx">{children}</div>
    </div>
  );
}
