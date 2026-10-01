import { Fleet } from "@/components/Fleet";

// Today's Fleet view, inside the v4 frame until the overview screen (THE-867) replaces it.
export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const params = await searchParams;
  return <Fleet initialProject={typeof params.project === "string" ? params.project : null} />;
}
