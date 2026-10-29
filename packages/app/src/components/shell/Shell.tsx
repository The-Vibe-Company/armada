import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

// Motion's animation features load after the first paint, off the first-load budget.
const features = () => import("./motion-features").then((m) => m.default);

/** The shell: the sidebar on its plane, the page beside it, hairlines between. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={features} strict>
        <div className="flex h-full min-w-[720px] bg-bg">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </LazyMotion>
    </MotionConfig>
  );
}
