"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { formString } from "@/lib/action";
import { requireViewer } from "@/lib/data/viewer";
import { ACK_COOKIE, ACK_MIGRATION_COOKIE, isAckKey, writeAcks } from "@/lib/sandbox-attention";

/**
 * Acknowledges this sandbox's current attention state, or takes the acknowledgement back (#801). It is kept in a cookie of this
 * browser, scoped to the signed-in viewer: an acknowledgement is a personal view preference over rows that are already
 * the viewer's to see, so it needs no table, no migration and no write under row level security. Losing it (another
 * browser, cleared cookies) only shows the row again; the key names the state, so a new turn or failure shows again.
 */
async function setAcknowledged(data: FormData, remove: boolean): Promise<void> {
  const key = formString(data, "key");
  if (!isAckKey(key)) return;
  const viewer = await requireViewer();
  const jar = await cookies();
  jar.set(ACK_COOKIE, writeAcks(jar.get(ACK_COOKIE)?.value, viewer.id, key, remove), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/sandboxes",
    maxAge: 60 * 60 * 24 * 14,
  });
  jar.set(ACK_MIGRATION_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/fleet",
    maxAge: 60 * 60 * 24 * 14,
  });
  revalidatePath(`/sandboxes/${key.slice(0, 36)}`);
}

export async function acknowledgeAttention(data: FormData): Promise<void> {
  await setAcknowledged(data, false);
}

export async function restoreAttention(data: FormData): Promise<void> {
  await setAcknowledged(data, true);
}
