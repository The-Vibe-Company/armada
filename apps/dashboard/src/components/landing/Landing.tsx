import { Cli } from "./Cli";
import { FleetLive } from "./FleetLive";
import { Hero, Nav } from "./Hero";
import { Method } from "./Method";
import { Crew, Footer, Install, Keys } from "./Sections";

// The landing's sections, top to bottom (THE-887).
export function Landing() {
  return (
    <div className="lp">
      <a href="#main" className="lp-skip">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Method />
        <FleetLive />
        <Crew />
        <Cli />
        <Keys />
        <Install />
      </main>
      <Footer />
    </div>
  );
}
