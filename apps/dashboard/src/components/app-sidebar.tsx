"use client";

import type { ReactNode } from "react";
import { Sidebar, SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

/** The full header belongs to the sidebar, which becomes a drawer on mobile. */
export function AppSidebar({
  header,
  launch,
  footer,
  children,
}: {
  header: ReactNode;
  launch: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { isMobile, state } = useSidebar();
  return (
    <Sidebar collapsible="icon" className="md:sticky md:top-0 md:h-dvh md:shrink-0">
      <SidebarHeader className="gap-0 p-0">
        {state === "collapsed" && !isMobile ? (
          <SidebarTrigger className="mx-auto my-3" aria-label="Expand navigation" />
        ) : (
          header
        )}
        {!isMobile && launch}
      </SidebarHeader>
      {children}
      {(isMobile || state !== "collapsed") && (
        <SidebarFooter className="mt-auto gap-0 border-t px-3 py-3">{footer}</SidebarFooter>
      )}
    </Sidebar>
  );
}

/** Keep the desktop opener out of the mobile drawer so it cannot replace the drawer's focus-return target. */
export function DesktopSidebarTrigger() {
  const { isMobile } = useSidebar();
  return isMobile ? null : <SidebarTrigger className="hidden md:flex" aria-label="Collapse navigation" />;
}
