import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToString } from "react-dom/server";
import { HostRetention } from "@/components/docker-hosts";
import { SnapshotCreateChoice } from "@/components/docker-snapshot-forms";
import { GoldenForm } from "@/components/golden-form";
import { LaunchComposer } from "@/components/launch-composer";
import { LaunchStart } from "@/components/launch-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { DockerHost } from "@/lib/docker-hosts";

const router = { refresh() {}, push() {} } as unknown as AppRouterInstance;

test("LaunchComposer keeps the template chooser visible while typing a prompt", () => {
  const render = (props: { task: string; template?: string }) =>
    renderToString(
      <Dialog open>
        <LaunchComposer
          id="launch-1"
          headline="What should we build?"
          docker={false}
          task={props.task}
          onTask={() => {}}
          holds={[]}
          tools={null}
          skills={null}
          agent={null}
          location={null}
          options={null}
          chooser={<div data-test-chooser>Or start from a template</div>}
          {...(props.template ? { template: props.template } : {})}
        />
      </Dialog>,
    );

  expect(render({ task: "Fix login bug" })).toContain("Or start from a template");
  expect(render({ task: "Fix login bug", template: "review-pr" })).not.toContain("Or start from a template");
});

test("LaunchStart avoids broken 'in No repository?' headline when no repository is selected", () => {
  const html = renderToString(
    <AppRouterContext.Provider value={router}>
      <Dialog open>
        <LaunchStart
          golden="web-app"
          provider="boat"
          orgId="org-1"
          catalog={MODEL_CATALOG}
          connections={{ connections: [] }}
          accounts={{ state: "ready", orgName: "Acme", accounts: [], now: 0 }}
          repositories={[]}
        />
      </Dialog>
    </AppRouterContext.Provider>,
  );

  expect(html).toContain("What should we build?");
  expect(html).not.toContain("What should we build in");
});

test("Cloud and Docker snapshot forms share Where to build -> Name -> Visible to order and accurate timing hints", () => {
  const host: DockerHost = {
    id: "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2",
    name: "build-box",
    state: "online",
    createdAt: "2026-11-13T08:00:00Z",
    lastSeenAt: "2026-11-13T11:59:50Z",
    revokedAt: null,
    protocol: 1,
    upgradeRequired: false,
    sandboxes: 0,
    version: "1.4.0",
  };
  const html = renderToString(
    <AppRouterContext.Provider value={router}>
      <Dialog open>
        <SnapshotCreateChoice
          orgId="org-1"
          orgName="Acme"
          isAdmin
          hosts={[host]}
          canBuild
          cloudForms={{
            boat: <GoldenForm mode="create" orgId="org-1" orgName="Acme" isAdmin providers={["boat"]} />,
          }}
        />
      </Dialog>
    </AppRouterContext.Provider>,
  );

  const cloudStart = html.indexOf('data-golden-form="create"');
  const dockerHtml = html.slice(0, cloudStart);
  const cloudHtml = html.slice(cloudStart);

  for (const part of [dockerHtml, cloudHtml]) {
    const whereIdx = part.indexOf("Where to build");
    const nameIdx = part.indexOf("Snapshot name");
    const visIdx = part.indexOf("Visible to");
    const reposIdx = part.indexOf("Repositories");
    const setupIdx = part.indexOf("Setup commands");
    expect(whereIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(whereIdx);
    expect(visIdx).toBeGreaterThan(nameIdx);
    expect(reposIdx).toBeGreaterThan(visIdx);
    expect(setupIdx).toBeGreaterThan(reposIdx);
  }

  expect(cloudHtml).toContain("Runs each time a sandbox launches from this cloud snapshot.");
  expect(dockerHtml).toContain("Runs once while building this Docker snapshot.");
});

test("HostRetention formats durations cleanly and omits raw byte parentheticals", () => {
  const host: DockerHost = {
    id: "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2",
    name: "build-box",
    state: "online",
    createdAt: "2026-11-13T08:00:00Z",
    lastSeenAt: "2026-11-13T11:59:50Z",
    revokedAt: null,
    protocol: 1,
    upgradeRequired: false,
    sandboxes: 1,
    version: "1.4.0",
    retentionSeconds: 86400,
    retentionOverrideSeconds: 43200,
    diskFreeBytes: 50_000_000_000,
    stoppedSandboxBytes: 2_500_000_000,
  };
  const html = renderToString(<HostRetention orgId="org-1" host={host} />);

  expect(html).toContain("1 day");
  expect(html).toContain("12 hours");
  expect(html).toContain("50.00 GB");
  expect(html).toContain("2.50 GB");
  expect(html).not.toContain("bytes)");
});
