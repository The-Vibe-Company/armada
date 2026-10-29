import type { ReactNode } from "react";

/**
 * The v7 page anatomy (design/dashboard-v7): a line of facts, the 22 px title
 * and a quiet line, then the page's blocks. The title is the app's only h1
 * (test/anatomy.test.tsx refuses one anywhere else).
 */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 max-w-[1080px] flex-col gap-5.5 px-8 pt-7 pb-14">{children}</div>;
}

export function PageHeader({ facts, title, quiet }: { facts?: ReactNode; title: ReactNode; quiet?: ReactNode }) {
  return (
    <header className="flex min-w-0 flex-col gap-2">
      {facts && <div className="m-0 flex flex-wrap items-center gap-2 text-meta text-text-2">{facts}</div>}
      <h1 className="m-0 text-pretty text-title">{title}</h1>
      {quiet && <p className="m-0 text-sub text-text-2">{quiet}</p>}
    </header>
  );
}

/** One of the page's blocks, under its quiet heading. */
export function Block({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col">
      <h2 className="m-0 pb-2 font-medium text-heading text-text-3">{heading}</h2>
      {children}
    </section>
  );
}

/** A separator between two facts of the facts line. */
export function Dot() {
  return (
    <span aria-hidden className="text-text-3">
      ·
    </span>
  );
}
