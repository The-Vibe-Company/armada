import { Page, SkeletonRows, SkeletonStatus } from "@/components/page";

// While the page reads Postgres (THE-899): its status and rows as skeletons, in their places.
export default function Loading() {
  return (
    <Page status={<SkeletonStatus />}>
      <SkeletonRows count={8} />
    </Page>
  );
}
