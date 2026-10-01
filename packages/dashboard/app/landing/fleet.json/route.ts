import { demoOverview } from "@/lib/demo/overview";

// The demo world's overview the landing's replica plays (THE-887): built once,
// at build, served as a static file. The replica fetches it as it nears the
// screen, so the landing's first load carries neither it nor the dashboard's code.
export const dynamic = "force-static";

export function GET() {
  return Response.json(demoOverview(new Date()));
}
