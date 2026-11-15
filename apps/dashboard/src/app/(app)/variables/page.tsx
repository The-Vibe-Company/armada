import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import VariablesContent from "@/components/pages/variables-content";
import { RevalidatingContent } from "@/components/revalidating-content";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { refreshVariables } from "./refresh";

export const metadata: Metadata = { title: "Variables" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function VariablesPage({ searchParams }: Props) {
  const [viewer, selected, query] = await Promise.all([requireViewer(), selectedOrganization(), searchParams]);
  const scope = `${viewer.id}:${selected?.org.id ?? "none"}`;
  const renderId = randomUUID();
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined) params.append(key, value);
  }
  const path = `/variables${params.size ? `?${params}` : ""}`;
  return (
    <RevalidatingContent
      key={renderId}
      scope={scope}
      path={path}
      renderId={renderId}
      refresh={refreshVariables.bind(null, scope, query)}
    >
      {await VariablesContent({ searchParams: Promise.resolve(query) })}
    </RevalidatingContent>
  );
}
