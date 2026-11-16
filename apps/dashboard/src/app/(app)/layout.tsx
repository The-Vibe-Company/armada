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
import { dockerHostsEnabled } from "@/lib/data/docker-hosts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { parseSandboxListMetadata } from "@/lib/sandbox-access";
import { sandboxListName } from "@/lib/sandbox-list-name";
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
      <div className="flex items-center justify-end gap-2.5 px-1.5">
        <span className="flex-1" />
        <DesktopSidebarTrigger />
        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <SignOut compact />
        </div>
      </div>
      <OrgSwitcher memberships={memberships} selected={selected?.org.id ?? null} role={selected?.role ?? null} />
      <ShellSearch />
      <div className="[&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-[13px] [&_button]:text-foreground [&_button]:shadow-none [&_button:hover]:bg-[var(--raised)]">
        <SandboxLaunchAction />
      </div>
    </div>
  );
  const liveSandboxes = selected ? loadLiveSandboxes(selected.org.id) : Promise.resolve([]);
  return (
    <SidebarProvider
      data-shell
      style={{ "--sidebar-width": "244px" } as CSSProperties}
      className="min-h-dvh flex-col md:flex-row"
    >
      <AppSidebar
        header={header}
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
        <Suspense fallback={<NavLinks className="px-3 pb-4" optIns={{ dockerHosts: dockerHostsEnabled() }} />}>
          <ShellNavigation sandboxes={liveSandboxes} />
        </Suspense>
      </AppSidebar>
      <CommandMenu />
      <Toaster />
      <main className="w-full min-w-0 flex-1 space-y-6 px-4 py-6 md:px-6 md:py-6">
        <ShellBreadcrumb organization={selected?.org.name ?? "Armada"} />
        {children}
      </main>
    </SidebarProvider>
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

async function loadLiveSandboxes(orgId: string) {
  const supabase = await createClient();
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase
      .rpc("sandbox_list_metadata")
      .eq("orgId", orgId)
      .in("status", ["starting", "ready", "running", "stopping"])
      .order("id")
      .range(from, from + 499);
    if (error?.code === "PGRST103") break;
    if (error) return [];
    const parsed = parseSandboxListMetadata(data);
    rows.push(
      ...parsed.rows
        .filter((row) => row.canOpen)
        .map((row) => ({ id: row.id, label: sandboxListName(row), status: row.status })),
    );
    if (parsed.rows.length + parsed.skipped.length < 500) break;
  }
  return rows;
}

async function ShellNavigation({ sandboxes }: { sandboxes: ReturnType<typeof loadLiveSandboxes> }) {
  return <NavLinks className="px-3 pb-4" optIns={{ dockerHosts: dockerHostsEnabled() }} sandboxes={await sandboxes} />;
}
