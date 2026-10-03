import { LazyReplica } from "./LazyReplica";

// The fleet, live (THE-887, THE-931): the dashboard's overview, playing the demo world.
export function FleetLive() {
  return (
    <section className="lp-section lp-fleet" id="fleet" aria-labelledby="lp-fleet-title">
      <div className="lp-glow is-blue" aria-hidden />
      <div className="lp-head is-center">
        <span className="lp-eyebrow is-blue lp-reveal">The fleet, live</span>
        <h2 id="lp-fleet-title" className="lp-h2 lp-reveal">
          Every agent, every phase, one screen.
        </h2>
        <p className="lp-body lp-reveal">
          Every session in flight, grouped under the coordinator that runs it. The coordinators answer their workers and
          merge their pull requests; what only you can decide is marked To validate and comes first. Below, every
          session's day on one timeline.
        </p>
      </div>
      <div className="lp-fleet-stage lp-reveal is-tilt">
        <LazyReplica />
      </div>
      <ol className="lp-fleet-beats" aria-label="What the replica shows">
        <li data-beat="delivered">
          <span className="lp-mono">01</span>The coordinator answers a question; the worker is back at work
        </li>
        <li data-beat="handed-back">
          <span className="lp-mono">02</span>A green pull request is handed back to the coordinator
        </li>
        <li data-beat="to-validate">
          <span className="lp-mono">03</span>Its merge needs you: the session is To validate
        </li>
      </ol>
      <p className="lp-fleet-note">
        The dashboard's own components, playing the demo world (<span className="lp-mono">bun run demo:seed</span>)
        fifteen times faster.
      </p>
    </section>
  );
}
