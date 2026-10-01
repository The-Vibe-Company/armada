import { resolve } from "node:path";
import {
  type ArmadaConfig,
  type Attachment,
  attachmentImageType,
  type Credentials,
  checkAttachment,
  MAX_ATTACHMENT_BYTES,
  projectOf,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";

export async function attachItems(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  target: {
    ticket: string;
    items: string[];
    caption?: string;
    reference?: string;
    onAttached?: (saved: { attachment: Attachment; url: string }) => void;
  },
): Promise<{ attachment: Attachment; url: string }[]> {
  const ticket = target.ticket.toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket))
    throw new UsageError("attachment ticket limit: use a ticket identifier, e.g. WID-15");
  if (!target.items.length) throw new UsageError("attach needs at least one file or HTTPS URL");
  const signIn = credentials.armadaSignIn;
  if (!signIn) throw new UsageError("attachments need a sign-in to Armada", "armada login");
  if (signIn.kind === "worker" && (signIn.ticket !== ticket || signIn.project !== config.project.slug))
    throw new UsageError(
      `attachment ticket limit: this worker session acts on ${signIn.project}/${signIn.ticket} only`,
    );
  const api = apiOf(io, credentials.armadaApi.url);
  const uploaded: { attachment: Attachment; url: string }[] = [];
  for (const item of target.items) {
    let input: { kind: "image"; contentType: string; data: string } | { kind: "link"; url: string };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) {
      const link = { kind: "link" as const, url: item };
      const refusal = checkAttachment(link);
      if (refusal) throw new UsageError(refusal);
      input = link;
    } else {
      if (!io.readBinaryFile) throw new UsageError("this CLI cannot read attachment files");
      const bytes = await io.readBinaryFile(resolve(io.cwd, item), MAX_ATTACHMENT_BYTES);
      if (!bytes) throw new UsageError(`attachment file not found: ${item}`);
      const contentType = attachmentImageType(bytes) ?? "";
      const refusal = checkAttachment({ kind: "image", contentType, bytes });
      if (refusal) throw new UsageError(refusal);
      input = { kind: "image", contentType, data: Buffer.from(bytes).toString("base64") };
    }
    const saved = await api.attach(signIn, {
      project: projectOf(config),
      ticket,
      input,
      caption: target.caption ?? null,
      reference: target.reference ?? null,
    });
    uploaded.push(saved);
    target.onAttached?.(saved);
  }
  return uploaded;
}

export async function attachCommand(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; options: Record<string, string> },
): Promise<number> {
  const [ticket, ...items] = args.rest;
  if (!ticket) throw new UsageError("attach needs a ticket and at least one file or HTTPS URL");
  await attachItems(io, config, credentials, {
    ticket,
    items,
    caption: args.options.caption,
    reference: args.options.for,
    onAttached: (saved) => io.stdout(`${saved.url}\n`),
  });
  return 0;
}
