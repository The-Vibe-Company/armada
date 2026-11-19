import { expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useLaunchAccess } from "../src/components/launch-dialog";
import { CONNECTION_CHOICE_FIELD, launchSelection, type McpConnection } from "../src/lib/connections";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const connection: McpConnection = {
  id: "tool_one",
  name: "Example tool",
  orgId: "org_one",
  scope: "personal",
  transport: "http",
  authType: "none",
  status: "connected",
  defaultForLaunch: true,
};
function Form() {
  const access = useLaunchAccess({ connections: [connection] });
  return (
    <form>
      <input name={CONNECTION_CHOICE_FIELD} value={access.explicit ? "explicit" : "defaults"} readOnly />
      <button type="button" onClick={() => access.toggle(connection.id, false)}>
        Remove tool
      </button>
      {access.inputs}
    </form>
  );
}
test("Docker launch tools show the default and removing it produces an explicit empty selection", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Form));
  });
  expect(renderer.root.findByProps({ name: "connections" }).props.value).toBe(connection.id);
  await act(async () => {
    renderer.root.findByType("button").props.onClick();
  });
  expect(renderer.root.findByProps({ name: CONNECTION_CHOICE_FIELD }).props.value).toBe("explicit");
  expect(
    launchSelection({
      connections: renderer.root
        .findAll((node) => node.type === "input" && node.props.name === "connections")
        .map((node) => node.props.value),
      available: [connection],
    }),
  ).toEqual({
    ok: true,
    value: { connections: [] },
  });
  await act(async () => {
    renderer.unmount();
  });
});

test("Docker snapshot launch summarizes authorized default tools", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LaunchStart } = await import("../src/components/launch-dialog");
  const { MODEL_CATALOG } = await import("@armada/core");
  const { Dialog } = await import("../src/components/ui/dialog");
  const markup = renderToStaticMarkup(
    createElement(
      Dialog,
      {},
      createElement(LaunchStart, {
        golden: "snapshot",
        snapshotId: "snapshot_one",
        provider: "docker",
        orgId: "org_one",
        catalog: MODEL_CATALOG,
        connections: { connections: [connection] },
        accounts: { state: "unavailable", reason: "unavailable" },
        repositories: [],
      }),
    ),
  );
  expect(markup).toContain("Example tool");
  expect(markup).toContain('name="connections"');
});

test("empty Docker machine launch exposes the same authorized tools", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { DockerLaunchForm } = await import("../src/components/docker-launch");
  const markup = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      {
        value: {} as NonNullable<React.ContextType<typeof AppRouterContext>>,
      },
      createElement(DockerLaunchForm, {
        orgId: "org_one",
        hostId: "host_one",
        hostName: "Host",
        accounts: { state: "unavailable", reason: "unavailable" },
        connections: { connections: [connection] },
        unavailable: [],
        harnesses: ["codex"],
        initialHarness: "codex",
      }),
    ),
  );
  expect(markup).toContain("Example tool");
  expect(markup).toContain('name="connections"');
});
