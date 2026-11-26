import { expect, test } from "bun:test";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToString } from "react-dom/server";
import { PageHeader } from "@/components/page-header";
import { ShellToolbar } from "@/components/shell-toolbar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";

test("the server renders the signed-in shell header once on a non-thread route", () => {
  const html = renderToString(
    <PathnameContext.Provider value="/variables">
      <SidebarProvider>
        <AppSidebar
          header={<button type="button">Switch organization</button>}
          launch={<button type="button">Launch with shortcut</button>}
          footer={null}
        >
          <nav id="main-navigation-links">Variables</nav>
        </AppSidebar>
        <ShellToolbar organization="Acme" launch={null} />
      </SidebarProvider>
    </PathnameContext.Provider>,
  );

  expect(html.match(/>Switch organization<\/button>/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Toggle navigation"');
  expect(html.match(/Launch with shortcut/g)).toHaveLength(1);
});

test("page actions are in the same header as the title on the initial render", () => {
  const html = renderToString(
    <PageHeader title="Templates">
      <button type="button">New template</button>
    </PageHeader>,
  );

  expect(html).toMatch(/<header[^>]*>.*<h1[^>]*>Templates<\/h1>.*<button[^>]*>New template<\/button>.*<\/header>/);
});

test("ShellToolbar appends API keys breadcrumb only on /settings/api-keys", () => {
  const renderToolbar = (path: string) =>
    renderToString(
      <PathnameContext.Provider value={path}>
        <SidebarProvider>
          <ShellToolbar organization="Acme" launch={null} />
        </SidebarProvider>
      </PathnameContext.Provider>,
    );

  const apiKeysHtml = renderToolbar("/settings/api-keys");
  expect(apiKeysHtml).toContain("Your connections");
  expect(apiKeysHtml).toContain("API keys");

  const settingsHtml = renderToolbar("/settings");
  expect(settingsHtml).toContain("Your connections");
  expect(settingsHtml).not.toContain("API keys");
});
