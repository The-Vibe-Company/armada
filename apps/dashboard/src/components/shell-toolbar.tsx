"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { isActiveLink, NAV_GROUPS } from "@/lib/navigation";

export function ShellSearch() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 w-full justify-start gap-2 bg-[var(--surface)] px-2.5 text-[13px] font-normal text-muted-foreground"
      onClick={() => window.dispatchEvent(new Event("armada:open-search"))}
    >
      <SearchIcon className="size-3.5" />
      <span className="flex-1 text-left">Search</span>
      <Kbd>⌘K</Kbd>
    </Button>
  );
}

export function ShellToolbar({ organization, launch }: { organization: string; launch: ReactNode }) {
  const pathname = usePathname();
  const { openMobile, triggerRef } = useSidebar();
  const destination = NAV_GROUPS.flatMap((group) => group.links).find((link) => isActiveLink(pathname, link.href));
  const sandboxId = pathname.startsWith("/sandboxes/") ? pathname.split("/")[2] : undefined;
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-2 text-[13px] backdrop-blur-sm md:px-7">
      <SidebarTrigger
        ref={triggerRef}
        className="size-11 md:hidden"
        aria-label="Toggle navigation"
        aria-expanded={openMobile}
        aria-controls={openMobile ? "main-navigation-links" : undefined}
      />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        <span className="hidden truncate text-muted-foreground md:inline">{organization}</span>
        <span aria-hidden className="hidden text-[var(--faint)] md:inline">
          /
        </span>
        {destination ? (
          <Link className="truncate font-medium hover:underline" href={destination.href}>
            {destination.label}
          </Link>
        ) : (
          <span className="truncate font-medium">Dashboard</span>
        )}
        {sandboxId && (
          <span className="hidden shrink-0 gap-2 font-mono text-xs sm:inline-flex" title={sandboxId}>
            <span aria-hidden className="text-[var(--faint)]">
              /
            </span>
            {sandboxId.slice(0, 8)}
          </span>
        )}
      </nav>
      <div data-shell-launch className="ml-auto shrink-0 md:hidden">
        {launch}
      </div>
    </header>
  );
}
