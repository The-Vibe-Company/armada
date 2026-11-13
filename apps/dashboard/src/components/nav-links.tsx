"use client";

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
  RadarIcon,
  ServerIcon,
  SettingsIcon,
  VariableIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, Suspense, use } from "react";

import { LinkPendingIcon } from "@/components/link-pending";
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
import { cn } from "@/lib/utils";

/** Each destination's glyph; the order and labels live in `NAV_GROUPS`. */
const ICONS: Record<NavIcon, LucideIcon> = {
  sandboxes: BoxesIcon,
  otto: RadarIcon,
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

export function NavLinks({ className, optIns }: { className?: string; optIns: NavOptIns }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarContent className={cn("gap-0", className)}>
      <nav id="main-navigation-links" aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="p-0 pt-4 first:pt-0" role="region" aria-label={group.label}>
            <SidebarGroupLabel
              asChild
              className="h-auto px-2 text-xs font-medium text-foreground group-data-[collapsible=icon]:mt-0 group-data-[collapsible=icon]:h-0"
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
                          "h-auto min-h-9 gap-2.5 px-2 py-2 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:min-h-0 md:py-1.5",
                          active
                            ? "bg-background text-foreground shadow-xs ring-1 ring-border data-[active=true]:bg-background"
                            : "text-muted-foreground",
                        )}
                      >
                        <Link
                          href={href}
                          onClick={() => setOpenMobile(false)}
                          aria-current={active ? "page" : undefined}
                        >
                          <LinkPendingIcon>
                            <Icon />
                          </LinkPendingIcon>
                          <span className="truncate">{label}</span>
                        </Link>
                      </SidebarMenuButton>
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
