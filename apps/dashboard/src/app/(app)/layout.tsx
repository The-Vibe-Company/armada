import { LogOutIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, Suspense } from "react";
import { AppSidebar, DesktopSidebarTrigger, SignOutForm } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { NavLinks } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { SandboxLaunchAction } from "@/components/sandbox-launch-action";
import { ShellSearch, ShellToolbar } from "@/components/shell-toolbar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { readLiveSandboxes } from "@/lib/live-sandboxes";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in shell: the organization in scope and the navigation on the left (on top on a phone), the page on
 * the right, toasts over both. The public pages do not use this layout, and it adds no global styles.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [viewer, supabase, selected] = await Promise.all([requireViewer(), createClient(), selectedOrganization()]);
  const memberships = await listMemberships(supabase, viewer.id);
  const header = (
    <div className="space-y-2 px-3 pt-3 pb-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <OrgSwitcher memberships={memberships} selected={selected?.org.id ?? null} role={selected?.role ?? null} />
        </div>
        <DesktopSidebarTrigger />
      </div>
      <ShellSearch />
    </div>
  );
  const liveSandboxes = selected ? readLiveSandboxes(supabase, selected.org.id) : Promise.resolve(null);
  const shell = (
    <SidebarProvider
      data-shell
      style={{ "--sidebar-width": "244px" } as CSSProperties}
      className="min-h-dvh flex-col md:flex-row [&:has(main_[data-page-launch])_[data-shell-launch]]:hidden"
    >
      <AppSidebar
        header={header}
        launch={
          <div data-shell-launch className="px-3 pb-2 group-data-[state=collapsed]:px-2">
            <SandboxLaunchAction shortcut />
          </div>
        }
        footer={
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-[var(--raised)] text-[11px] font-semibold text-muted-foreground uppercase"
            >
              {viewer.email.charAt(0)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{viewer.email.split("@")[0]}</p>
              <p className="truncate font-mono text-[11px] text-[var(--faint)]" title={viewer.email}>
                {viewer.email}
              </p>
            </div>
            <ThemeToggle />
            <SignOut compact />
          </div>
        }
      >
        <Suspense
          fallback={
            <NavLinks
              organizationId={selected?.org.id ?? null}
              organizationAdmin={selected?.role === "admin"}
              className="px-3 pb-4"
            />
          }
        >
          <ShellNavigation
            organizationId={selected?.org.id ?? null}
            organizationAdmin={selected?.role === "admin"}
            sandboxes={liveSandboxes}
          />
        </Suspense>
      </AppSidebar>
      <CommandMenu organizationAdmin={selected?.role === "admin"} />
      <Toaster />
      <main className="min-w-0 flex-1">
        <ShellToolbar organization={selected?.org.name ?? "Armada"} launch={<SandboxLaunchAction />} />
        <div data-shell-content className="mx-auto w-full max-w-[1360px] space-y-6 px-5 py-5 md:px-7 md:py-6">
          {children}
        </div>
      </main>
    </SidebarProvider>
  );
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={300}>
      {shell}
    </TooltipProvider>
  );
}

function SignOut({ compact = false }: { compact?: boolean }) {
  return (
    <SignOutForm>
      <Button type="submit" variant="ghost" size={compact ? "icon" : "sm"} aria-label="Sign out">
        <LogOutIcon />
        {!compact && "Sign out"}
      </Button>
    </SignOutForm>
  );
}

async function ShellNavigation({
  sandboxes,
  organizationId,
  organizationAdmin,
}: {
  sandboxes: ReturnType<typeof readLiveSandboxes>;
  organizationId: string | null;
  organizationAdmin: boolean;
}) {
  return (
    <NavLinks
      organizationId={organizationId}
      organizationAdmin={organizationAdmin}
      className="px-3 pb-4"
      initialLive={await sandboxes}
    />
  );
}
