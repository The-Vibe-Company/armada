// A session's facts (THE-2028): its runtime and harness, its branch, its pull
// request and checks, when it was claimed and last reported, each after a dot
// but the first. Shared by its page's facts line and the room's agent lane (THE-2089).
import { Dot } from "@/components/page";
import type { PullRequestFact, SessionView } from "@/session/view";

export function Facts({ facts, at }: { facts: SessionView["facts"]; at: (time: string | null) => string }) {
  return (
    <>
      <span>
        {facts.runtime}
        {facts.harness && facts.harness.toLowerCase() !== facts.runtime.toLowerCase() && ` · ${facts.harness}`}
      </span>
      {facts.branch && (
        <>
          <Dot />
          <span className="max-w-[36ch] truncate font-mono" title={facts.branch}>
            {facts.branch}
          </span>
        </>
      )}
      {facts.pr && (
        <>
          <Dot />
          <PullRequest pr={facts.pr} />
        </>
      )}
      {facts.claimedAt && (
        <>
          <Dot />
          <span>
            claimed <span className="font-mono tnum">{at(facts.claimedAt)}</span>
          </span>
        </>
      )}
      {facts.reportedAt && (
        <>
          <Dot />
          <span>
            last report <span className="font-mono tnum">{at(facts.reportedAt)}</span>
          </span>
        </>
      )}
    </>
  );
}

function PullRequest({ pr }: { pr: PullRequestFact }) {
  const ink = pr.ci === "failure" ? "text-red" : pr.ci === "success" ? "text-green" : "text-text-2";
  const number = <span className="font-mono text-text">#{pr.number}</span>;
  return (
    <span>
      {pr.url ? (
        <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
          {number}
        </a>
      ) : (
        number
      )}{" "}
      <span className={ink}>{pr.checks}</span>
    </span>
  );
}
