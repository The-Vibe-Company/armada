import { LogOutIcon, ShipIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLinks } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { requireViewer } from "@/lib/data/viewer";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b md:sticky md:top-0 md:h-dvh md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:py-5">
          <div className="flex items-center gap-2 font-semibold">
            <ShipIcon className="size-5" />
            Armada
          </div>
          <div className="flex items-center gap-1 md:hidden">
            <ThemeToggle />
            <SignOut compact />
          </div>
        </div>
        <NavLinks className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible md:pb-0" />
        <div className="mt-auto hidden flex-col gap-2 border-t p-3 md:absolute md:inset-x-0 md:bottom-0 md:flex">
          <p className="truncate px-1 text-xs text-muted-foreground" title={viewer.email}>
            {viewer.email}
          </p>
          <div className="flex items-center justify-between">
            <SignOut />
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-4 md:p-8">{children}</main>
    </div>
  );
}

function SignOut({ compact = false }: { compact?: boolean }) {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size={compact ? "icon" : "sm"} aria-label="Sign out">
        <LogOutIcon />
        {!compact && "Sign out"}
      </Button>
    </form>
  );
}
