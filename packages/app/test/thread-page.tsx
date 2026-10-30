// The thread alone in a page (THE-2050), for test/thread.test.tsx's browser
// half: it mounts the room's Thread on the conversation the test hands it.
import type { ChatItem } from "@armada/protocol";
import { createRoot } from "react-dom/client";
import type { Group } from "../src/fleet/overview";
import { Thread } from "../src/room/Thread";

const given = (window as unknown as { THREAD: { items: ChatItem[]; groups: Record<string, Group> } }).THREAD;
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <Thread
      items={given.items}
      repository="example/harbor"
      groupOf={(ticket) => given.groups[ticket] ?? null}
      now={Date.parse("2026-03-10T15:00:00.000Z")}
      zone="UTC"
      empty="Nothing said yet."
    />,
  );
