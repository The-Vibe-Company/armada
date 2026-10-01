# Dashboard v5 mockup: "Night watch"

The proposed visual direction for the Armada dashboard (THE-898, 2026-10-01). Once the owner approves it, it is the reference for THE-899, "Build the approved new look across the dashboard".

The idea: the dashboard is the night sky the landing flies in, seen from the bridge. It keeps the Agents page's structure and the live fleet. The craft goes into light, type and the live feeling:

- three planes (sky, deck, instruments);
- the horizon glow, whose colour is the fleet's state;
- each page's status sentence in display type, which says "Welcome back" and replays your absence on one strip when you return;
- one meaning per colour;
- the formation mark used with restraint;
- the timeline drawn as flight paths;
- a bottom tab bar on the phone.

## Files

- `index.html`: the shell; open it to click through every screen.
- `styles.css`: every token and component. Each token's comment names the `globals.css` token it maps onto.
- `app.js`: a synthetic Acme world (the demo's Armada, Gadgets and Widgets projects), the hash routes and the motion.

The screens:

- `#/`: the overview;
- `#/agents`: Agents;
- `#/agents/THE-862`: an agent's page;
- `#/projects/armada`: a project's page;
- `#/validations`;
- `#/insights`;
- `#/activity`: every event on one rail, with your last visit as a line across it (THE-894);
- `#/system`: the direction itself, with tokens, live contrast ratios, the type scale, the motion table, the mark's uses and density.

The Prototype panel, bottom right, switches:

- the state: live, loading, empty or error;
- the density: Compact or Airy;
- reduced motion;
- the horizon;
- "Since you were away" on the overview, on or off.

It also plays the merge moment. Query parameters set the same options for screenshots, for example `?mode=empty&density=airy&motion=reduced&panel=off#/agents`. Under 720 px the shell becomes the phone layout. It keeps THE-891's top bar, with the home mark, the organization and search, and moves the five sections from that bar into a bottom tab bar with labels and counts. THE-891's other rules for narrow screens stay as built: nothing scrolls sideways, the timeline scrolls inside itself and has its table, and headers and bands wrap.

## Open it

Serve the folder:

```sh
bunx serve design/dashboard-v5
```

Then open `http://localhost:3000/`. Keyboard: `j` and `k` move through rows, `Enter` opens the selected row, `Escape` goes back.

## Rules for building it

- No new dependency.
- Keep THE-892's budgets green: Lighthouse 95 at 4× CPU, CLS 0, mobile LCP under 2.5 s, first-load JS within 5%, interactions under 200 ms. The System page lists each piece's cost and rule. The two that matter most:
  - render the status sentence and "Since you were away" with the page on the server, never inserted above content after paint;
  - use backdrop blur only on the phone's tab bar and on toasts.
- Motion uses transform and opacity only.
- Reduced motion keeps crossfades and nothing else.
- Every colour used for text passes AA on the deck and on a card; the System page computes the ratios.

This folder is a design artefact. It is excluded from lint and from the build, and nothing in `packages/` imports it.
