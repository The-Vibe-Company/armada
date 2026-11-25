"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NavMobileTrigger } from "@/components/nav-links";
import { Sidebar, SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

/** The full header belongs to the sidebar, which becomes a drawer on mobile. */
export function AppSidebar({
  header,
  launch,
  mobileLaunch,
  footer,
  children,
}: {
  header: ReactNode;
  launch: ReactNode;
  mobileLaunch: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { isMobile, state, openMobile, triggerRef } = useSidebar();
  const thread = usePathname().startsWith("/sandboxes/");
  return (
    <>
      <div className="border-b bg-sidebar px-3 py-2 md:hidden">
        {thread ? (
          <NavMobileTrigger />
        ) : (
          <div className="flex items-center justify-between gap-2">
            <SidebarTrigger
              ref={triggerRef}
              className="size-9"
              aria-label="Toggle navigation"
              aria-expanded={openMobile}
              aria-controls="main-navigation-links"
            />
            {isMobile && mobileLaunch}
          </div>
        )}
      </div>
      <Sidebar collapsible="icon" className="md:sticky md:top-0 md:h-dvh md:shrink-0">
        <SidebarHeader className="gap-0 p-0">
          {state === "collapsed" && !isMobile ? (
            <SidebarTrigger className="mx-auto my-3" aria-label="Expand navigation" />
          ) : (
            <>
              {header}
              {(!isMobile || thread) && launch}
            </>
          )}
        </SidebarHeader>
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
