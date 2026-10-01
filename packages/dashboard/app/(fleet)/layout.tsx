import { Shell } from "@/components/shell/Shell";
import { requireFleetAccess } from "@/lib/access";
import { shellProps } from "@/lib/shell-server";

// The v4 frame of the fleet's pages (THE-866). It reads the overview once per
// full load; the pages inside render from the overview it polls, so moving
// between them never waits for the server.
export const dynamic = "force-dynamic";

export default async function FleetLayout({ children }: { children: React.ReactNode }) {
  const access = await requireFleetAccess();
  return <Shell {...(await shellProps(access))}>{children}</Shell>;
}
