import { LogOutIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, Suspense } from "react";
import { AppSidebar, DesktopSidebarTrigger } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { NavLinks } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { SandboxLaunchAction } from "@/components/sandbox-launch-action";
import { ShellBreadcrumb, ShellSearch } from "@/components/shell-toolbar";
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
  const viewer = await requireViewer();
  const memberships = await listMemberships(await createClient(), viewer.id);
  const selected = await selectedOrganization();
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
  const liveSandboxes = selected
    ? createClient().then((supabase) => readLiveSandboxes(supabase, selected.org.id))
    : Promise.resolve(null);
  const shell = (
    <SidebarProvider
      data-shell
      style={{ "--sidebar-width": "244px" } as CSSProperties}
      className="min-h-dvh flex-col md:flex-row [&:has(main_[data-page-launch])_[data-shell-launch]]:hidden"
    >
      <AppSidebar
        header={header}
        mobileLaunch={
          <div data-shell-launch>
            <SandboxLaunchAction />
          </div>
        }
        launch={
          <div
            data-shell-launch
            className="px-3 pb-2 group-data-[state=collapsed]:px-2 group-data-[state=collapsed]:[&_button]:justify-center group-data-[state=collapsed]:[&_button_span]:sr-only group-data-[state=collapsed]:[&_kbd]:hidden [&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-[13px] [&_button]:text-foreground [&_button]:shadow-none fine-hover:[&_button:hover]:bg-[var(--raised)]"
          >
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
      <main className="w-full min-w-0 flex-1 space-y-6 px-4 py-6 md:px-6 md:py-6">
        <ShellBreadcrumb organization={selected?.org.name ?? "Armada"} />
        {children}
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
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size={compact ? "icon" : "sm"} aria-label="Sign out">
        <LogOutIcon />
        {!compact && "Sign out"}
      </Button>
    </form>
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
