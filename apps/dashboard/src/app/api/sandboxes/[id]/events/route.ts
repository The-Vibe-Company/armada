import { NextResponse } from "next/server";
import { readSandboxConversation } from "@/lib/data/sandbox-conversation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const { body, status } = await readSandboxConversation(id, query.get("cursor"), "follow", query.get("pending"));
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
