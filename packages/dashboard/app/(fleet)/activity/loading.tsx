import { PageSkeleton } from "@/components/page";

// While the page reads Postgres (THE-899): its title and rows as skeletons, in their places.
export default function Loading() {
  return <PageSkeleton rows={10} />;
}
