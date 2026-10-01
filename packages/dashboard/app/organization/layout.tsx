import { Shell } from "@/components/shell/Shell";
import { requireFleetAccess } from "@/lib/access";
import { shellProps } from "@/lib/shell-server";

// The organization's pages (members, keys, GitHub, workers) open inside the
// v4 frame; their content is their own (THE-866).
export const dynamic = "force-dynamic";

export default async function OrganizationLayout({ children }: { children: React.ReactNode }) {
  const access = await requireFleetAccess();
  return (
    <Shell {...(await shellProps(access))}>
      <div className="sh-legacy">{children}</div>
    </Shell>
  );
}
