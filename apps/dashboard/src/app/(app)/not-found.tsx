import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="space-y-4 rounded-xl border bg-background p-6 text-foreground">
      <h1 className="text-xl font-semibold">This page could not be found</h1>
      <p className="text-sm text-muted-foreground">It may no longer exist, or you may not have access to it.</p>
      <Button asChild variant="outline">
        <Link href="/sandboxes">Back to sandboxes</Link>
      </Button>
    </section>
  );
}
