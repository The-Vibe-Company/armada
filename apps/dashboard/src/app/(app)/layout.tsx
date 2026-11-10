import { LogOutIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { CommandMenu, CommandMenuTrigger } from "@/components/command-menu";
import { NavLinks } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in shell: the organization in scope and the navigation on the left (on top on a phone), the page on
 * the right. The public pages do not use this layout, and it adds no global styles.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const memberships = await listMemberships(await createClient(), viewer.id);
  const selected = await selectedOrganization();
  return (
    <div data-shell className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:flex md:h-dvh md:w-64 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 md:px-5 md:pt-5 md:pb-4">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <BrandMark />
            Armada
          </div>
          <div className="flex items-center gap-1 md:hidden">
            <CommandMenuTrigger compact />
            <ThemeToggle />
            <SignOut compact />
          </div>
        </div>
        <OrgSwitcher memberships={memberships} selected={selected?.org.id ?? null} role={selected?.role ?? null} />
        <div className="hidden px-3 pb-2 md:block">
          <CommandMenuTrigger />
        </div>
        <NavLinks className="grid grid-cols-4 gap-1 px-3 pb-3 md:flex md:flex-col md:gap-0.5 md:overflow-y-auto md:pb-4" />
        <div className="mt-auto hidden border-t px-3 py-3 md:block">
          <div className="flex items-center gap-2.5 px-2 pb-2">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground uppercase ring-1 ring-border"
            >
              {viewer.email.charAt(0)}
            </span>
            <p className="min-w-0 truncate text-xs text-muted-foreground" title={viewer.email}>
              Signed in as <span className="text-foreground">{viewer.email}</span>
            </p>
          </div>
          <div className="flex items-center justify-between">
            <SignOut />
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <CommandMenu />
      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 space-y-6 px-4 py-6 md:px-10 md:py-10">{children}</main>
    </div>
  );
}

function SignOut({ compact = false }: { compact?: boolean }) {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size={compact ? "icon" : "sm"} aria-label="Sign out">
        <LogOutIcon />
        {!compact && "Sign out"}
      </Button>
    </form>
  );
}
