"use client";

import {
  BoxesIcon,
  CameraIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  NetworkIcon,
  PackageIcon,
  PlugIcon,
  SettingsIcon,
  UsersIcon,
  VariableIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { cn } from "@/lib/utils";

/**
 * Grouped in the order the work happens: sandboxes and orchestrators are what runs (Run), environments, templates,
 * tools, skills, variables and harness subscriptions are set up once (Build), and the account pages sit last. The
 * hint, a tooltip, says what each page holds. On a phone the eleven links fit two rows of six, so the conversation
 * pages keep their height.
 */
const GROUPS = [
  {
    label: "Run",
    links: [
      { href: "/fleet", label: "Fleet", hint: "Every agent and what needs you", icon: GaugeIcon },
      { href: "/sandboxes", label: "Sandboxes", short: "Boxes", hint: "Running agents and logs", icon: BoxesIcon },
      {
        href: "/orchestrators",
        label: "Orchestrators",
        short: "Orchs",
        hint: "Lasting coordinators of workers",
        icon: NetworkIcon,
      },
    ],
  },
  {
    label: "Build",
    links: [
      {
        href: "/environments",
        label: "Environments",
        short: "Envs",
        hint: "Goldens: what a sandbox contains when it starts",
        icon: CameraIcon,
      },
      {
        href: "/templates",
        label: "Templates",
        short: "Tmpls",
        hint: "Launch presets: environment, tools, model and variables",
        icon: LayoutTemplateIcon,
      },
      { href: "/tools", label: "Tools", hint: "MCP connections your agents can use", icon: PlugIcon },
      { href: "/skills", label: "Skills", hint: "The Skillpack key for private skills", icon: PackageIcon },
      {
        href: "/variables",
        label: "Variables",
        short: "Vars",
        hint: "Configuration and write-only secrets",
        icon: VariableIcon,
      },
      { href: "/harness", label: "Harness", hint: "Claude Code and Codex subscriptions", icon: KeyRoundIcon },
    ],
  },
  {
    label: "Account",
    links: [
      { href: "/orgs", label: "Organizations", short: "Orgs", hint: "Members and roles", icon: UsersIcon },
      { href: "/settings", label: "Settings", hint: "Sandbox providers, provider keys and GitHub", icon: SettingsIcon },
    ],
  },
] as const;

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={className}>
      {GROUPS.map((group) => (
        <Fragment key={group.label}>
          <p
            aria-hidden="true"
            className="hidden px-2 pt-5 pb-1.5 text-xs font-medium text-muted-foreground first:pt-1 md:block"
          >
            {group.label}
          </p>
          {group.links.map((link) => {
            const { href, label, hint, icon: Icon } = link;
            const short = "short" in link ? link.short : label;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                title={hint}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-1 rounded-md px-0.5 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:flex-row md:gap-2.5 md:px-2 md:py-1.5 md:text-sm",
                  active
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border md:bg-background"
                    : "text-muted-foreground",
                )}
              >
                <LinkPendingIcon>
                  <Icon />
                </LinkPendingIcon>
                {/* A phone's six columns take a shorter word where the full one would be cut. */}
                <span className="truncate md:hidden">
                  {short}
                  {/* The visible word starts the accessible name (label in name), the full one follows. */}
                  {short !== label && <span className="sr-only"> ({label})</span>}
                </span>
                <span className="hidden truncate md:inline">{label}</span>
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
