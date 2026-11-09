import { LazyReplica } from "./LazyReplica";

// The fleet (THE-887, THE-931), restored by #564: a static replay of the
// Armada v1 dashboard's overview, labelled as such. It is not today's dashboard.
export function FleetLive() {
  return (
    <section className="lp-section lp-fleet" id="fleet" aria-labelledby="lp-fleet-title">
      <div className="lp-glow is-blue" aria-hidden />
      <div className="lp-head is-center">
        <span className="lp-eyebrow is-blue lp-reveal">From Armada v1, replayed</span>
        <h2 id="lp-fleet-title" className="lp-h2 lp-reveal">
          Every agent, every phase, one screen.
        </h2>
        <p className="lp-body lp-reveal">
          Armada v1 was a fleet orchestrator, and this was its overview: every session in one list, grouped by state,
          each row saying why in its state's color. Armada today is the launcher underneath; its dashboard lists your
          sandboxes, their agents and their events, and the orchestrating is your agent's.
        </p>
      </div>
      <div className="lp-fleet-stage lp-reveal is-tilt">
        <LazyReplica />
      </div>
      <ol className="lp-fleet-beats" aria-label="What the v1 replay shows">
        <li data-beat="delivered">
          <span className="lp-mono">01</span>The coordinator answers a question; the worker is back at work
        </li>
        <li data-beat="handed-back">
          <span className="lp-mono">02</span>A green pull request is handed back to the coordinator
        </li>
        <li data-beat="to-validate">
          <span className="lp-mono">03</span>Its merge needs you: the session waits for your decision
        </li>
      </ol>
      <p className="lp-fleet-note">
        A static replay of the archived v1 demo (<span className="lp-mono">armada-v1-final</span>), fifteen times
        faster. Nothing in it is live.
      </p>
    </section>
  );
}
