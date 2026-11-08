"use client";

import { BoxesIcon, CameraIcon, KeyRoundIcon, SettingsIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { LinkPendingIcon } from "@/components/link-pending";
import { cn } from "@/lib/utils";

/**
 * Grouped in the order the work happens: keys and repositories are set up once (Build), sandboxes are
 * launched from goldens (Run), and the account pages sit last. The hint says what each page holds.
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
            className="hidden px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase first:pt-0 md:block"
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
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none has-[[data-pending]]:bg-accent has-[[data-pending]]:text-accent-foreground",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                <LinkPendingIcon>
                  <Icon />
                </LinkPendingIcon>
                <span className="flex flex-col">
                  {label}
                  <span aria-hidden="true" className="hidden text-xs font-normal text-muted-foreground md:block">
                    {hint}
                  </span>
                </span>
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
