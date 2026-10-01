"use client";

// One image attachment, full size, in a modal dialog. Loaded only when the
// viewer opens one (THE-892): the agent's page does not carry it.
import type { Attachment } from "@armada/core/read";
import Image from "next/image";
import { useEffect, useRef } from "react";
import type { Strings } from "@/lib/i18n";
import { Button, CardMeta } from "../page";
import { RelativeTime } from "../ui";

export function AttachmentViewer({ item, onClose, t }: { item: Attachment; onClose: () => void; t: Strings }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  const a = t.shell.agent;
  return (
    <dialog
      ref={dialog}
      className="attachment-dialog"
      onCancel={onClose}
      onClose={onClose}
      aria-label={item.caption ?? a.attachments}
    >
      <Button onClick={onClose}>{a.closeAttachment}</Button>
      <Image
        src={`/api/attachments/${item.id}`}
        alt={item.caption ?? a.attachments}
        width={960}
        height={720}
        unoptimized
      />
      <p>{item.caption}</p>
      <CardMeta>
        {item.author} · <RelativeTime at={item.createdAt} />
      </CardMeta>
    </dialog>
  );
}
