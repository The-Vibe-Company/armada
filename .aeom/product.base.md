# Armada

## What kind of product
`tool`: an open-source launcher for coding agents, used from a web dashboard, the `armada` CLI and an MCP server; this run covers its public landing page, the page a developer meets before signing in. (seen: README.md) (seen: /)

## What it is for
Armada gives every coding task its own machine: a developer snapshots their repositories once as a golden, then launches Claude Code or Codex into a fresh Boat or Modal sandbox with the model and reasoning effort they choose, follows every event, redirects the agent mid-turn, stops the machine and picks the same conversation back up later, from the web, the terminal or any MCP client. The landing says this to a developer who has not signed in yet and sends them either to sign in in the browser or to install the CLI. (seen: README.md) (seen: /)

## Who uses it
Developers and the people who coordinate coding agents for a team, who read the landing to decide whether to try Armada, then sign in or install the CLI. (seen: README.md) How often they come back to the landing itself is not said. (to confirm)

## Where it is used
`both`: the landing is a public page shared by link, read on a computer before installing a CLI and also opened on a phone. (to confirm)

## The main loop
On the landing: read what Armada does, see how a golden, a launch, a sandbox and its driving fit together, then either sign in to try Armada in the browser or copy the install command and the first CLI commands. In the product itself: build a golden, launch an agent into a sandbox, follow and steer it, stop it and resume it. (seen: /) (seen: README.md)

## Visual assets
- The logo: five small triangles in a V, the lead one lime green, the others off-white, the back two fainter, like a formation seen from above. (seen: apps/dashboard/src/components/landing/Mark.tsx)
- The hero: a night sky drawn on a canvas, where squadrons of small coloured triangle ships fly in and the logo's formation breaks apart, behind a large white headline. (seen: /) (seen: apps/dashboard/src/components/landing/Sky.tsx)
- The README's masthead and diagram: off-white text and lime marks on near-black, with a monospace for commands and a plain sans for words. (seen: docs/images/armada-masthead.svg) (seen: docs/images/armada-how-it-works-dark.svg)

## Accepted exceptions
- `gradient-text` on /: the hero's "See every move." shine is the accepted hero, kept exactly as it is. (seen: issue #610)
- `font-size` on /: the hero's version tag is part of the accepted hero, kept exactly as it is. (seen: issue #610)
- `motion` on /: the navigation and hero transitions belong to the accepted hero, kept exactly as they are. (seen: issue #610)
- `nested-radius` on /: the hero's install command button is part of the accepted hero, kept exactly as it is. (seen: issue #610)
- `finish` on /: the favicon is served by the root layout (#596), outside this page's scope. (seen: issue #610)

## Key journeys

### Try Armada in the browser
Why: a developer convinced by the page wants to start without installing anything. (seen: /)
1. Open `/`.
2. Read down to the last section of the page.
3. Click "Sign in to try Armada".
4. Land on `/login`.

### Install the CLI
Why: a developer who works in the terminal wants the install command and the first commands to type. (seen: /) (seen: README.md)
1. Open `/`.
2. Click "Install" in the navigation.
3. See `npm install -g @the-vibe-company/armada` and `armada login` on the page.

### See how a task gets its own sandbox
Why: a developer wants to understand what a golden is and what a launch gives each agent before trusting it with their code. (seen: /)
1. Open `/`.
2. Click "Method" in the navigation.
3. See how a golden is built.
4. Click "Fleet" in the navigation.
5. See that each launch gets a sandbox of its own, with Claude Code or Codex.

On a phone the navigation hides "Method", "Fleet", "CLI" and "Keys", so this journey breaks at step 2 at 390 px. (seen: / at 390 px)

### Check where my keys go
Why: a developer wants to know what happens to their model and provider credentials before storing them. (seen: /)
1. Open `/`.
2. Click "Keys" in the navigation.
3. See that keys are sealed with AES-256-GCM and that a golden holds none.

On a phone the navigation hides "Keys", so this journey breaks at step 2 at 390 px. (seen: / at 390 px)
