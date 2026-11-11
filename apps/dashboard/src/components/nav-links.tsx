"use client";

import {
  BoxesIcon,
  CameraIcon,
  ChevronDownIcon,
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
import { useState } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Relationships stay visible on desktop and in the phone navigation menu. */
const GROUPS = [
  {
    label: "Run",
    description: "Each sandbox is one launch.",
    links: [{ href: "/sandboxes", label: "Sandboxes", hint: "Running agents and logs", icon: BoxesIcon }],
  },
  {
    label: "Start with",
    description: "A machine and an agent account.",
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
    description: "Tools, instructions and configuration.",
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
    description: "Templates bring these choices together.",
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
    description: "Membership and connections.",
    links: [
      { href: "/orgs", label: "Organizations", hint: "Members and roles", icon: UsersIcon },
      { href: "/settings", label: "Settings", hint: "Sandbox providers, provider keys and GitHub", icon: SettingsIcon },
    ],
  },
] as const;

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const current = GROUPS.flatMap((group) => [...group.links]).find(
    (link) => pathname === link.href || pathname.startsWith(`${link.href}/`),
  );
  return (
    <nav aria-label="Main" className={className}>
      <Button
        variant="ghost"
        className="mb-1 w-full justify-between md:hidden"
        aria-expanded={expanded}
        aria-controls="main-navigation-links"
        onClick={() => setExpanded(!expanded)}
      >
        <span>
          Navigation <span className="text-muted-foreground">/ {current?.label ?? "Dashboard"}</span>
        </span>
        <ChevronDownIcon className={cn("size-4", expanded && "rotate-180")} />
      </Button>
      <div id="main-navigation-links" className={cn(expanded ? "block" : "hidden", "md:block")}>
        {GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="pt-4 first:pt-0">
            <h2 className="px-2 text-xs font-medium text-foreground">{group.label}</h2>
            <p className="px-2 pt-1 pb-2 text-xs leading-relaxed text-muted-foreground">{group.description}</p>
            <div className="grid grid-cols-2 gap-1 md:grid-cols-1 md:gap-0.5">
              {group.links.map((link) => {
                const { href, label, hint, icon: Icon } = link;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={href}
                    href={href}
                    title={hint}
                    onClick={() => setExpanded(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:flex-row md:gap-2.5 md:px-2 md:py-1.5 md:text-sm",
                      active
                        ? "bg-background text-foreground shadow-xs ring-1 ring-border md:bg-background"
                        : "text-muted-foreground",
                    )}
                  >
                    <LinkPendingIcon>
                      <Icon />
                    </LinkPendingIcon>
                    <span className="truncate">{label}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </nav>
  );
}
