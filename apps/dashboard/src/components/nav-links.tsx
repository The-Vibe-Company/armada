"use client";

import type { SandboxStatus } from "@armada/core";
import {
  BoxesIcon,
  CalendarClockIcon,
  CameraIcon,
  ChevronDownIcon,
  CloudIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  ServerIcon,
  SettingsIcon,
  VariableIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, Suspense, startTransition, use, useEffect } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { StatusDot } from "@/components/status-badge";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { isActiveLink, NAV_GROUPS, type NavIcon, type NavOptIn } from "@/lib/navigation";
import { statusLook } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/** Each destination's glyph; the order and labels live in `NAV_GROUPS`. */
const ICONS: Record<NavIcon, LucideIcon> = {
  sandboxes: BoxesIcon,
  routines: CalendarClockIcon,
  templates: LayoutTemplateIcon,
  environments: CameraIcon,
  skills: PackageIcon,
  tools: PlugIcon,
  variables: VariableIcon,
  selfHosted: ServerIcon,
  cloud: CloudIcon,
  models: KeyRoundIcon,
  settings: SettingsIcon,
};

/**
 * Destinations behind a server opt-in. The shell passes the server's answer as a promise and does not wait for it:
 * only the entry itself appears once the answer says the server offers it.
 */
export type NavOptIns = Record<NavOptIn, Promise<boolean>>;

function OptIn({ when, children }: { when: Promise<boolean>; children: ReactNode }) {
  return use(when) ? children : null;
}

export function NavMobileTrigger() {
  const pathname = usePathname();
  const { openMobile } = useSidebar();
  const current = NAV_GROUPS.flatMap((group) => group.links).find((link) => isActiveLink(pathname, link.href));
  return (
    <SidebarTrigger
      variant="ghost"
      size="default"
      className="mb-1 h-9 w-full justify-between md:hidden"
      aria-expanded={openMobile}
      aria-controls="main-navigation-links"
    >
      <span>
        Navigation <span className="text-muted-foreground">/ {current?.label ?? "Dashboard"}</span>
      </span>
      <ChevronDownIcon className={cn("size-4", openMobile && "rotate-180")} />
    </SidebarTrigger>
  );
}

/** Read dynamic destinations on demand instead of eagerly rendering every sidebar page.
 * The shared loading boundary keeps navigation responsive; visited routes still use the router cache.
 */
export function NavLinks({
  className,
  optIns,
  sandboxes = [],
  organizationId = null,
}: {
  organizationId?: string | null;
  className?: string;
  optIns: NavOptIns;
  sandboxes?: { id: string; label: string; status: SandboxStatus }[];
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);

  return (
    <SidebarContent className={cn("gap-0", className)}>
      <nav id="main-navigation-links" aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="p-0 pt-4 first:pt-0" role="region" aria-label={group.label}>
            <SidebarGroupLabel
              asChild
              className="h-auto px-2 pb-1 text-xs font-medium text-[var(--faint)] group-data-[collapsible=icon]:mt-0 group-data-[collapsible=icon]:h-0"
            >
              <h2>{group.label}</h2>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.links.map((link) => {
                  const { href, label } = link;
                  const Icon = ICONS[link.icon];
                  const active = isActiveLink(pathname, href);
                  const item = (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={label}
                        className={cn(
                          "h-8 min-h-8 gap-2.5 px-2 py-1.5 text-[13px] font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:min-h-0 md:py-1.5",
                          active
                            ? "bg-[var(--surface)] text-foreground shadow-xs ring-1 ring-border data-[active=true]:bg-[var(--surface)]"
                            : "text-muted-foreground",
                        )}
                      >
                        <Link
                          href={
                            href === "/orgs" && organizationId ? `/orgs/${encodeURIComponent(organizationId)}` : href
                          }
                          prefetch={false}
                          onClick={() => setOpenMobile(false)}
                          aria-current={active ? "page" : undefined}
                        >
                          <LinkPendingIcon>
                            <Icon />
                          </LinkPendingIcon>
                          <span className="truncate">{label}</span>
                          {href === "/sandboxes" && sandboxes.length > 0 && (
                            <span
                              className="ml-auto rounded bg-[var(--accent-tint)] px-1.5 text-xs tabular-nums text-[var(--accent-text)]"
                              title={`${sandboxes.length} live sandboxes`}
                            >
                              {sandboxes.length}
                            </span>
                          )}
                        </Link>
                      </SidebarMenuButton>
                      {href === "/sandboxes" && sandboxes.length > 0 && (
                        <ul className="my-1 ml-[15px] space-y-px border-l pl-2 group-data-[collapsible=icon]:hidden">
                          {sandboxes.map((sandbox) => {
                            const look = statusLook(sandbox.status);
                            return (
                              <li key={sandbox.id}>
                                <Link
                                  href={`/sandboxes/${sandbox.id}`}
                                  prefetch={false}
                                  onClick={() => setOpenMobile(false)}
                                  title={`${sandbox.label} · ${look.label}`}
                                  aria-current={pathname === `/sandboxes/${sandbox.id}` ? "page" : undefined}
                                  className={cn(
                                    "flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-[var(--raised)] hover:text-foreground",
                                    pathname === `/sandboxes/${sandbox.id}` && "bg-[var(--raised)] text-foreground",
                                  )}
                                >
                                  <StatusDot tone={look.tone} pulse={look.pulse} />
                                  <span className="truncate">{sandbox.label}</span>
                                  <span className="sr-only">{look.label}</span>
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </SidebarMenuItem>
                  );
                  if (!link.optIn) return item;
                  return (
                    <Suspense key={href} fallback={null}>
                      <OptIn when={optIns[link.optIn]}>{item}</OptIn>
                    </Suspense>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </nav>
    </SidebarContent>
  );
}
