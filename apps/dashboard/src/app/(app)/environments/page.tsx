import { redirect } from "next/navigation";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Keep bookmarked details and in-progress build recovery links working. */
export default async function EnvironmentsRedirect({ searchParams }: Props) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  redirect(`/snapshots${query.size ? `?${query}` : ""}`);
}
