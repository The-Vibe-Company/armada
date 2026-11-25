import { expect, test } from "bun:test";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToString } from "react-dom/server";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";

test("the server renders the signed-in shell header once on a non-thread route", () => {
  const html = renderToString(
    <PathnameContext.Provider value="/variables">
      <SidebarProvider>
        <AppSidebar
          header={<button type="button">Switch organization</button>}
          launch={<button type="button">Launch with shortcut</button>}
          mobileLaunch={<button type="button">New sandbox</button>}
          footer={null}
        >
          <nav id="main-navigation-links">Variables</nav>
        </AppSidebar>
      </SidebarProvider>
    </PathnameContext.Provider>,
  );

  expect(html.match(/>Switch organization<\/button>/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Toggle navigation"');
  expect(html.match(/Launch with shortcut|New sandbox/g)).toHaveLength(1);
});
