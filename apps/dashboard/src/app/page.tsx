import { redirect } from "next/navigation";

// A member's `/` (the proxy shows a signed-out visitor the landing on the same URL): rendered on each request, so
// no shared cache keeps this redirect, or the landing, for the other.
export const dynamic = "force-dynamic";

export default function Home() {
  redirect("/sandboxes");
}
