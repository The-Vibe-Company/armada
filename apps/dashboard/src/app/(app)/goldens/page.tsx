import type { Golden } from "@armada/core";
import { GlobeIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import { setGoldenVisibility } from "@/app/actions/goldens";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listGoldens } from "@/lib/data/goldens";
import { displayUser, listMemberships, type Membership, memberDirectory, requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Goldens" };
export const dynamic = "force-dynamic";

export default async function GoldensPage() {
  const viewer = await requireViewer();
  const supabase = await createClient();
  const pending = listMemberships(supabase, viewer.id);
  const [goldens, memberships, directory] = await Promise.all([
    listGoldens(supabase),
    pending,
    pending.then((items) =>
      memberDirectory(
        supabase,
        items.map((item) => item.org.id),
      ),
    ),
  ]);
  const orgs = new Map(memberships.map((item) => [item.org.id, item]));
  const mine = goldens.filter((golden) => golden.visibility === "private");
  const shared = goldens.filter((golden) => golden.visibility === "org");

  return (
    <>
      <PageHeader
        title="Goldens"
        description="Saved snapshots that sandboxes start from. Create and snapshot them with `armada golden`."
      />
      <Section
        title="Private"
        description="Only you see these."
        goldens={mine}
        orgs={orgs}
        directory={directory}
        viewerId={viewer.id}
      />
      <Section
        title="Shared with your orgs"
        description="Every member of the org sees these. Only an org admin changes them."
        goldens={shared}
        orgs={orgs}
        directory={directory}
        viewerId={viewer.id}
      />
    </>
  );
}

type SectionProps = {
  title: string;
  description: string;
  goldens: Golden[];
  orgs: Map<string, Membership>;
  directory: Map<string, string>;
  viewerId: string;
};

function Section({ title, description, goldens, orgs, directory, viewerId }: SectionProps) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {goldens.length === 0 ? (
        <Empty title={`No ${title.toLowerCase()} goldens`} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Snapshot</TableHead>
                <TableHead>Org</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Visibility change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {goldens.map((golden) => (
                <GoldenRow
                  key={golden.id}
                  golden={golden}
                  membership={orgs.get(golden.org_id)}
                  directory={directory}
                  viewerId={viewerId}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function GoldenRow({
  golden,
  membership,
  directory,
  viewerId,
}: {
  golden: Golden;
  membership: Membership | undefined;
  directory: Map<string, string>;
  viewerId: string;
}) {
  const isOwner = golden.owner_id === viewerId;
  const isAdmin = membership?.role === "admin";
  const next = golden.visibility === "private" ? "org" : "private";
  return (
    <TableRow data-golden={golden.name}>
      <TableCell className="font-medium">{golden.name}</TableCell>
      <TableCell>
        <Badge variant={golden.visibility === "private" ? "secondary" : "outline"} className="gap-1">
          {golden.visibility === "private" ? <LockIcon className="size-3" /> : <GlobeIcon className="size-3" />}
          {golden.visibility === "private" ? "Private" : "Org"}
        </Badge>
      </TableCell>
      <TableCell>
        {golden.boat_snapshot_id ? (
          <span className="font-mono text-xs" title="boat.dev saved snapshot">
            {golden.boat_snapshot_id}
          </span>
        ) : (
          <span className="text-muted-foreground">Not snapshotted</span>
        )}
      </TableCell>
      <TableCell>{membership?.org.name ?? "Unknown"}</TableCell>
      <TableCell>{displayUser(directory, golden.owner_id, viewerId)}</TableCell>
      <TableCell className="text-right">
        {!isOwner ? (
          <span className="text-xs text-muted-foreground">Owner only</span>
        ) : next === "org" && !isAdmin ? (
          <span className="text-xs text-muted-foreground">Org admins share goldens</span>
        ) : (
          <ActionForm action={setGoldenVisibility} className="flex flex-col items-end gap-1">
            <input type="hidden" name="golden" value={golden.id} />
            <input type="hidden" name="visibility" value={next} />
            <SubmitButton variant="outline" size="sm">
              {next === "org" ? "Share with org" : "Make private"}
            </SubmitButton>
          </ActionForm>
        )}
      </TableCell>
    </TableRow>
  );
}
