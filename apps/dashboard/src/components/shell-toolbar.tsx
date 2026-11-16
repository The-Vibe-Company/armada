"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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

export function ShellBreadcrumb({ organization }: { organization: string }) {
  const pathname = usePathname();
  const destination = NAV_GROUPS.flatMap((group) => group.links).find((link) => isActiveLink(pathname, link.href));
  return (
    <header className="-mx-4 -mt-6 mb-6 flex min-h-[52px] shrink-0 flex-wrap py-2 items-center gap-2 border-b bg-background px-4 text-[13px] md:-mx-6 md:px-6">
      <span className="truncate text-muted-foreground">{organization}</span>
      <span className="text-[var(--faint)]">/</span>
      {destination ? (
        <Link className="shrink-0 hover:underline" href={destination.href}>
          {destination.label}
        </Link>
      ) : (
        <span>Dashboard</span>
      )}
      {pathname.startsWith("/sandboxes/") && (
        <>
          <span className="text-[var(--faint)]">/</span>
          <span className="truncate font-mono text-xs">{pathname.split("/")[2]}</span>
        </>
      )}
      <div id="shell-page-actions" className="ml-auto flex shrink-0 flex-wrap justify-end gap-2" />
    </header>
  );
}
