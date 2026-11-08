"use client";

import { BoxesIcon, CameraIcon, KeyRoundIcon, SettingsIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/sandboxes", label: "Sandboxes", icon: BoxesIcon },
  { href: "/goldens", label: "Goldens", icon: CameraIcon },
  { href: "/credentials", label: "Credentials", icon: KeyRoundIcon },
  { href: "/orgs", label: "Organizations", icon: UsersIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={className}>
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:bg-accent hover:text-accent-foreground",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
