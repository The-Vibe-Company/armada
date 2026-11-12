"use client";

import type { ReactNode } from "react";
import { NavMobileTrigger } from "@/components/nav-links";
import { Sidebar, SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

/** Mount the organization switcher only once, including across responsive layouts. */
export function AppSidebar({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { isMobile, state } = useSidebar();
  return (
    <>
      {isMobile && (
        <div className="border-b bg-sidebar pb-2 md:hidden">
          {header}
          <div className="px-3">
            <NavMobileTrigger />
          </div>
        </div>
      )}
      <Sidebar collapsible="icon" className="md:sticky md:top-0 md:h-dvh md:shrink-0">
        {isMobile === false && (
          <SidebarHeader className="gap-0 p-0">
            {state === "collapsed" ? (
              <SidebarTrigger className="mx-auto my-3" aria-label="Expand navigation" />
            ) : (
              header
            )}
          </SidebarHeader>
        )}
        {children}
        {isMobile === false && state !== "collapsed" && (
          <SidebarFooter className="mt-auto gap-0 border-t px-3 py-3">{footer}</SidebarFooter>
        )}
      </Sidebar>
    </>
  );
}
