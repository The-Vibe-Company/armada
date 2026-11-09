import { Hero, Nav } from "./Hero";
import { Footer } from "./Sections";
import { Story } from "./Story";

// The landing's sections, top to bottom (THE-887): the hero, then the story (#587).
export function Landing() {
  return (
    <div className="lp">
      <a href="#main" className="lp-skip">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Story />
      </main>
      <Footer />
    </div>
  );
}
