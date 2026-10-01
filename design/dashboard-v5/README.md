# Dashboard v5 mockup: "Night watch"

The proposed visual direction for the Armada dashboard (THE-898, 2026-10-01). Once the owner approves it, it is the reference for THE-899, "Build the approved new look across the dashboard".

The idea: the dashboard is the night sky the landing flies in, seen from the bridge. It keeps the Agents page's structure and the live fleet. The craft goes into light, type and the live feeling:

- three planes (sky, deck, instruments);
- the horizon glow, whose colour is the fleet's state;
- each page's status sentence in display type;
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
- `#/system`: the direction itself, with tokens, live contrast ratios, the type scale, the motion table, the mark's uses and density.

The Prototype panel, bottom right, switches:

- the state: live, loading, empty or error;
- the density: Compact or Airy;
- reduced motion;
- the horizon.

It also plays the merge moment. Query parameters set the same options for screenshots, for example `?mode=empty&density=airy&motion=reduced&panel=off#/agents`. Under 720 px the shell becomes the phone layout.

## Open it

Serve the folder:

```sh
bunx serve design/dashboard-v5
```

Then open `http://localhost:3000/`. Keyboard: `j` and `k` move through rows, `Enter` opens the selected row, `Escape` goes back.

## Rules for building it

- No new dependency.
- Motion uses transform and opacity only.
- Reduced motion keeps crossfades and nothing else.
- Every colour used for text passes AA on the deck and on a card; the System page computes the ratios.

This folder is a design artefact. It is excluded from lint and from the build, and nothing in `packages/` imports it.
