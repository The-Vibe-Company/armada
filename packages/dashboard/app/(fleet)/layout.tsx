import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DocumentLanguage } from "@/components/DocumentLanguage";
import { Shell } from "@/components/shell/Shell";
import { requireFleetAccess } from "@/lib/access";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";
import { shellProps } from "@/lib/shell-server";

// The v4 frame of the fleet's pages (THE-866). It reads the overview once per
// full load; the pages inside render from the overview it polls, so moving
// between them never waits for the server.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)].htmlTitle };
}

export default async function FleetLayout({ children }: { children: React.ReactNode }) {
  const access = await requireFleetAccess();
  return (
    <>
      <DocumentLanguage />
      <Shell {...(await shellProps(access))}>{children}</Shell>
    </>
  );
}
