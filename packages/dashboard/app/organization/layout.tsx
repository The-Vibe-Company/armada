import { DocumentLanguage } from "@/components/DocumentLanguage";
import { Shell } from "@/components/shell/Shell";
import { requireFleetAccess } from "@/lib/access";
import { shellProps } from "@/lib/shell-server";

// The organization's pages (members, keys, GitHub, workers) open inside the
// v4 frame, built from the page kit like every page of it (THE-876).
export const dynamic = "force-dynamic";

export default async function OrganizationLayout({ children }: { children: React.ReactNode }) {
  const access = await requireFleetAccess();
  return (
    <>
      <DocumentLanguage />
      <Shell {...(await shellProps(access))}>{children}</Shell>
    </>
  );
}
