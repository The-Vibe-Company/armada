"use client";

import type { Attachment } from "@armada/core/read";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Strings } from "@/lib/i18n";
import { Card, CardGrid, CardMeta, CardTitle, Row, RowSide, RowText, SectionBody } from "../page";
import { RelativeTime } from "../ui";

import { useLazy } from "../use-lazy";

// The full-size viewer loads apart, once the ticket has an image (THE-892).
const loadViewer = () => import("./AttachmentViewer").then((m) => m.AttachmentViewer);

export function useAttachments(project: string, ticket: string, version: number | string) {
  const [reading, setReading] = useState<{
    key: string;
    version: number | string;
    items: Attachment[];
    failed: boolean;
  } | null>(null);
  const key = `${project}/${ticket}`;
  // A ticket the server refused (403 without an organization, 404): asking again on every poll changes nothing.
  const refused = useRef(new Set<string>());
  useEffect(() => {
    if (refused.current.has(key)) return;
    const controller = new AbortController();
    fetch(`/api/fleet/attachments?${new URLSearchParams({ project, ticket })}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status >= 400 && response.status < 500) refused.current.add(key);
        if (!response.ok) throw new Error("attachments unavailable");
        const body = await response.json();
        setReading({ key, version, items: body.attachments, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setReading({ key, version, items: [], failed: true });
      });
    return () => controller.abort();
  }, [project, ticket, key, version]);
  return reading?.key === key ? reading : null;
}

export function Attachments({ items, failed, t }: { items: Attachment[] | null; failed: boolean; t: Strings }) {
  const requested = useSearchParams().get("attachment");
  const [chosen, setChosen] = useState<string | null>(requested);
  const selected = items?.find((item) => item.id === chosen && item.kind === "image");
  const AttachmentViewer = useLazy(loadViewer, !!items?.some((item) => item.kind === "image"));
  const a = t.shell.agent;
  if (failed || !items || items.length === 0)
    return (
      <SectionBody>
        <p>{failed ? a.attachmentsUnavailable : !items ? a.attachmentsLoading : a.noAttachments}</p>
      </SectionBody>
    );
  const images = items.filter((item) => item.kind === "image");
  const links = items.filter((item) => item.kind === "link");
  return (
    <>
      {images.length > 0 && (
        <SectionBody>
          <CardGrid>
            {images.map((item) => (
              <Card key={item.id}>
                <button
                  type="button"
                  className="attachment-thumbnail"
                  onClick={() => setChosen(item.id)}
                  aria-label={a.enlargeAttachment(item.caption ?? a.attachments)}
                >
                  <Image
                    src={`/api/attachments/${item.id}`}
                    alt={item.caption ?? a.attachments}
                    width={480}
                    height={160}
                    unoptimized
                  />
                </button>
                <CardTitle>{item.caption ?? a.attachments}</CardTitle>
                <CardMeta>
                  {item.author} · <RelativeTime at={item.createdAt} />
                </CardMeta>
              </Card>
            ))}
          </CardGrid>
        </SectionBody>
      )}
      {links.map((item) => (
        <Row key={item.id} href={`/api/attachments/${item.id}`}>
          <RowText title={item.caption ?? item.url} line={item.url} />
          <RowSide>
            {item.author} · <RelativeTime at={item.createdAt} />
          </RowSide>
        </Row>
      ))}
      {selected && AttachmentViewer && <AttachmentViewer item={selected} onClose={() => setChosen(null)} t={t} />}
    </>
  );
}
