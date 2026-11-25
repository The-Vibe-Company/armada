"use client";

import {
  BoxesIcon,
  CalendarClockIcon,
  CameraIcon,
  CloudIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  ServerIcon,
  SettingsIcon,
  VariableIcon,
  WebhookIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentProps, useEffect, useRef, useState } from "react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { warmChatCache } from "@/lib/chat-cache";
import {
  INLINE_LIVE_LIMIT,
  LIVE_FLEET_REFRESH_EVENT,
  LIVE_SANDBOXES_HREF,
  type LiveSandboxes,
  liveSandboxLook,
} from "@/lib/live-sandbox-view";
import { isActiveLink, NAV_GROUPS, type NavIcon } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Each destination's glyph; the order and labels live in `NAV_GROUPS`. */
const ICONS: Record<NavIcon, LucideIcon> = {
  sandboxes: BoxesIcon,
  routines: CalendarClockIcon,
  triggers: WebhookIcon,
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

function useLiveSandboxes(
  organizationId: string | null,
  initialLive: LiveSandboxes | null | undefined,
  enabled: boolean,
) {
  const [update, setUpdate] = useState<{ initial: typeof initialLive; organizationId: string; live: LiveSandboxes }>();
  useEffect(() => {
    if (!enabled || !organizationId || initialLive === undefined) return;
    const scope = organizationId;
    const url = `/api/fleet/live?organizationId=${encodeURIComponent(organizationId)}`;
    let pending: AbortController | undefined;
    let queuedRefresh = false;
    const active = () => document.visibilityState === "visible" && document.hasFocus();
    async function poll() {
      if (!active()) return;
      if (pending) {
        queuedRefresh = true;
        return;
      }
      const request = new AbortController();
      pending = request;
      queuedRefresh = false;
      try {
        const response = await fetch(url, { signal: request.signal });
        if (!response.ok) return;
        const rows: LiveSandboxes["rows"] = await response.json();
        const rawTotal = response.headers.get("X-Live-Count");
        const parsedTotal = rawTotal === null ? Number.NaN : Number(rawTotal);
        const total = Number.isFinite(parsedTotal) ? parsedTotal : rows.length;
        if (active() && !request.signal.aborted) {
          setUpdate({ initial: initialLive, organizationId: scope, live: { rows, total } });
        }
      } catch {
        return;
      } finally {
        if (pending === request) {
          pending = undefined;
          if (queuedRefresh && active() && !request.signal.aborted) void poll();
        }
      }
    }

    function onActivity() {
      if (active()) void poll();
      else {
        pending?.abort();
        pending = undefined;
      }
    }

    void poll();
    const interval = window.setInterval(poll, 30_000);
    window.addEventListener("focus", onActivity);
    window.addEventListener("blur", onActivity);
    window.addEventListener(LIVE_FLEET_REFRESH_EVENT, onActivity);
    document.addEventListener("visibilitychange", onActivity);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("blur", onActivity);
      window.removeEventListener(LIVE_FLEET_REFRESH_EVENT, onActivity);
      document.removeEventListener("visibilitychange", onActivity);
      pending?.abort();
    };
  }, [enabled, initialLive, organizationId]);
  return update && update.initial === initialLive && update.organizationId === organizationId
    ? update.live
    : initialLive;
}

function IntentLink({
  href,
  onIntent,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string; onIntent?: (() => void) | undefined }) {
  const router = useRouter();
  const timer = useRef<number | undefined>(undefined);
  function cancel() {
    window.clearTimeout(timer.current);
  }
  function prefetch() {
    cancel();
    timer.current = window.setTimeout(() => {
      router.prefetch(href);
      onIntent?.();
    }, 60);
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onMouseEnter={prefetch}
      onMouseLeave={(event) => {
        if (document.activeElement !== event.currentTarget) cancel();
      }}
      onFocus={prefetch}
      onBlur={(event) => {
        if (!event.currentTarget.matches(":hover")) cancel();
      }}
    />
  );
}

export function NavLinks({
  className,
  initialLive,
  organizationId = null,
  organizationAdmin = false,
}: {
  organizationId?: string | null;
  organizationAdmin?: boolean;
  className?: string;
  initialLive?: LiveSandboxes | null;
}) {
  const pathname = usePathname();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const live = useLiveSandboxes(organizationId, initialLive, isMobile === false || openMobile);
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
                  if (link.adminOnly && !organizationAdmin) return null;
                  const { href, label } = link;
                  const Icon = ICONS[link.icon];
                  const active = isActiveLink(pathname, href);
                  return (
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
                        <IntentLink
                          href={
                            href === "/orgs" && organizationId ? `/orgs/${encodeURIComponent(organizationId)}` : href
                          }
                          onClick={() => setOpenMobile(false)}
                          aria-current={active ? "page" : undefined}
                        >
                          <LinkPendingIcon>
                            <Icon />
                          </LinkPendingIcon>
                          <span className="truncate">{label}</span>
                        </IntentLink>
                      </SidebarMenuButton>
                      {href === "/sandboxes" && live && live.total > 0 && (
                        <ul className="my-1 ml-[15px] space-y-px border-l pl-2 group-data-[collapsible=icon]:hidden">
                          {live.rows.map((sandbox) => {
                            const look = liveSandboxLook(sandbox);
                            return (
                              <li key={sandbox.id}>
                                <IntentLink
                                  href={`/sandboxes/${sandbox.id}`}
                                  onIntent={
                                    organizationId ? () => void warmChatCache(organizationId, sandbox.id) : undefined
                                  }
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
                                </IntentLink>
                              </li>
                            );
                          })}
                          {live.total > INLINE_LIVE_LIMIT && (
                            <li>
                              <IntentLink
                                href={LIVE_SANDBOXES_HREF}
                                onClick={() => setOpenMobile(false)}
                                className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-[var(--raised)] hover:text-foreground"
                              >
                                View all {live.total} live →
                              </IntentLink>
                            </li>
                          )}
                        </ul>
                      )}
                    </SidebarMenuItem>
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
