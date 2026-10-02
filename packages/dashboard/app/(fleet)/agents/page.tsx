import { redirect } from "next/navigation";

type Params = Promise<Record<string, string | string[] | undefined>>;

// The Agents page became the overview (THE-916): its links, filters included, land there.
export default async function AgentsPage({ searchParams }: { searchParams: Params }) {
  const params = await searchParams;
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]],
    ),
  ).toString();
  redirect(query ? `/?${query}` : "/");
}
