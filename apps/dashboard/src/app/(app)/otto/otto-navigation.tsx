"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

export function OttoNavigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Otto" className="mb-6 flex flex-wrap gap-2">
      {(
        [
          ["/otto", "Observations"],
          ["/otto/objectives", "Objectives"],
          ["/otto/evidence", "Evidence"],
          ["/otto/engine", "Engine"],
          ["/otto/your-turn", "Your turn"],
        ] as const
      ).map(([href, label]) => {
        const active = href === "/otto" ? pathname === href : pathname.startsWith(href);
        return (
          <Button key={href} asChild variant={active ? "secondary" : "ghost"} size="sm">
            <Link href={href} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
