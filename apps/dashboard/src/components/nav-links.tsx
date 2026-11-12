"use client";

import {
  BoxesIcon,
  CameraIcon,
  ChevronDownIcon,
  Clock3Icon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PlugIcon,
  SettingsIcon,
  UsersIcon,
  VariableIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
import { cn } from "@/lib/utils";

/** The menu contains group labels and destinations only; relationships belong on the pages. */
const GROUPS = [
  {
    label: "Run",
    links: [
      { href: "/sandboxes", label: "Sandboxes", hint: "Running agents and logs", icon: BoxesIcon },
      { href: "/routines", label: "Routines", hint: "Scheduled template launches", icon: Clock3Icon },
    ],
  },
  {
    label: "Start with",
    links: [
      {
        href: "/environments",
        label: "Environments",
        hint: "Repositories and machine image a sandbox starts from",
        icon: CameraIcon,
      },
      { href: "/harness", label: "Harness", hint: "Claude Code and Codex accounts and models", icon: KeyRoundIcon },
    ],
  },
  {
    label: "Give the agent",
    links: [
      { href: "/tools", label: "Tools", hint: "MCP connections your agents can use", icon: PlugIcon },
      { href: "/skills", label: "Skills", hint: "The Skillpack key for private skills", icon: PackageIcon },
      {
        href: "/variables",
        label: "Variables",
        hint: "Configuration and write-only secrets",
        icon: VariableIcon,
      },
    ],
  },
  {
    label: "Save a combination",
    links: [
      {
        href: "/templates",
        label: "Templates",
        hint: "Saved environment, agent, tools, skills and variables",
        icon: LayoutTemplateIcon,
      },
    ],
  },
  {
    label: "Account",
    links: [
      { href: "/orgs", label: "Organizations", hint: "Members and roles", icon: UsersIcon },
      { href: "/settings", label: "Settings", hint: "Sandbox providers, provider keys and GitHub", icon: SettingsIcon },
    ],
  },
] as const;

export function NavMobileTrigger() {
  const pathname = usePathname();
  const { openMobile } = useSidebar();
  const current = GROUPS.flatMap((group) => [...group.links]).find(
    (link) => pathname === link.href || pathname.startsWith(`${link.href}/`),
  );
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

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarContent className={cn("gap-0", className)}>
      <nav id="main-navigation-links" aria-label="Main">
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="p-0 pt-4 first:pt-0" role="region" aria-label={group.label}>
            <SidebarGroupLabel asChild className="h-auto px-2 text-xs font-medium text-foreground">
              <h2>{group.label}</h2>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.links.map(({ href, label, hint, icon: Icon }) => {
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        className={cn(
                          "h-auto min-h-9 gap-2.5 px-2 py-2 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:min-h-0 md:py-1.5",
                          active
                            ? "bg-background text-foreground shadow-xs ring-1 ring-border data-[active=true]:bg-background"
                            : "text-muted-foreground",
                        )}
                      >
                        <Link
                          href={href}
                          title={hint}
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
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </nav>
    </SidebarContent>
  );
}
