import { NextResponse } from "next/server";
import { readSandboxConversation } from "@/lib/data/sandbox-conversation";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const cursor = new URL(request.url).searchParams.get("cursor");
  const { body, status } = await readSandboxConversation(id, cursor, "history");
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
