"use client";

import { usePathname } from "next/navigation";
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
  const thread = usePathname().startsWith("/sandboxes/");
  return (
    <>
      {isMobile && (
        <div className="border-b bg-sidebar pb-2 md:hidden">
          {!thread && header}
          <div className="px-3">
            <NavMobileTrigger />
          </div>
        </div>
      )}
      <Sidebar collapsible="icon" className="md:sticky md:top-0 md:h-dvh md:shrink-0">
        {(isMobile === false || thread) && (
          <SidebarHeader className="gap-0 p-0">
            {state === "collapsed" && !isMobile ? (
              <SidebarTrigger className="mx-auto my-3" aria-label="Expand navigation" />
            ) : (
              header
            )}
          </SidebarHeader>
        )}
        {children}
        {(isMobile || state !== "collapsed") && (
          <SidebarFooter className="mt-auto gap-0 border-t px-3 py-3">{footer}</SidebarFooter>
        )}
      </Sidebar>
    </>
  );
}

/** Keep the desktop opener out of the mobile drawer so it cannot replace the drawer's focus-return target. */
export function DesktopSidebarTrigger() {
  const { isMobile } = useSidebar();
  return isMobile ? null : <SidebarTrigger className="hidden md:flex" aria-label="Collapse navigation" />;
}
