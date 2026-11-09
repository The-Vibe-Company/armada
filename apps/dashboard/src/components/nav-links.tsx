"use client";

import { BoxesIcon, CameraIcon, KeyRoundIcon, PlugIcon, SettingsIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { cn } from "@/lib/utils";

/**
 * Grouped in the order the work happens: sandboxes are what runs (Run), goldens, keys and connections are set
 * up once (Build), and the account pages sit last. The hint, a tooltip, says what each page holds.
 */
const GROUPS = [
  {
    label: "Run",
    links: [{ href: "/sandboxes", label: "Sandboxes", hint: "Running agents and logs", icon: BoxesIcon }],
  },
  {
    label: "Build",
    links: [
      { href: "/goldens", label: "Goldens", hint: "Repositories and snapshots", icon: CameraIcon },
      { href: "/connections", label: "Connections", hint: "MCP servers and tools", icon: PlugIcon },
      { href: "/credentials", label: "Credentials", hint: "Agent and Boat keys", icon: KeyRoundIcon },
    ],
  },
  {
    label: "Account",
    links: [
      { href: "/orgs", label: "Organizations", hint: "Members and roles", icon: UsersIcon },
      { href: "/settings", label: "Settings", hint: "GitHub connection", icon: SettingsIcon },
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
          {group.links.map(({ href, label, hint, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                title={hint}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-1 rounded-md px-1 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground md:flex-row md:gap-2.5 md:px-2 md:py-1.5 md:text-sm",
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
        </Fragment>
      ))}
    </nav>
  );
}
