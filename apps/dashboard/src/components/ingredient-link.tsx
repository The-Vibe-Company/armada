import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/** A resource reference, not a status: wraps long names and stays keyboard/touch accessible. */
export function IngredientLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Badge
      asChild
      variant="outline"
      className="min-h-8 min-w-0 max-w-full shrink justify-start overflow-visible py-1 whitespace-normal [overflow-wrap:anywhere]"
    >
      <Link href={href}>{children}</Link>
    </Badge>
  );
}
