import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/** A resource reference, not a status: wraps long names and stays keyboard/touch accessible. */
export function IngredientLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Badge asChild variant="outline" className="min-h-8 max-w-full justify-start whitespace-normal break-words py-1">
      <Link href={href}>{children}</Link>
    </Badge>
  );
}
