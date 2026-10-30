// The thread alone in a page (THE-2054), for test/thread-scroll.test.tsx: the
// room's Thread in a box of fixed height, on the items the test hands it
// through `window.thread`, with the room's hold on its scroll.
import type { ChatItem } from "@armada/protocol";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Thread, type ThreadControl } from "../src/room/Thread";

let items: ChatItem[] = (window as unknown as { ITEMS: ChatItem[] }).ITEMS;
const control = createRef<ThreadControl>();
const box = document.getElementById("root");
let root: Root | null = null;

function render() {
  root?.render(
    <Thread
      items={items}
      project="harbor"
      repository="example/harbor"
      prefixes="THE"
      groupOf={() => null}
      now={Date.parse("2026-03-10T15:00:00.000Z")}
      zone="UTC"
      empty="Nothing said yet."
      control={control}
    />,
  );
}
function mount() {
  if (!box) return;
  root = createRoot(box);
  flushSync(render);
}

(window as unknown as { thread: unknown }).thread = {
  /** The next reading; drawn before it returns. */
  set(next: ChatItem[]) {
    items = next;
    flushSync(render);
  },
  anchor: () => control.current?.anchor(),
  page: (direction: "up" | "down") => control.current?.page(direction),
  unmount() {
    root?.unmount();
    root = null;
  },
  mount,
};
mount();
