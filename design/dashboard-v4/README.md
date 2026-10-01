# Dashboard v4 mockup

The approved design for the Armada dashboard (2026-10-01). It is the reference for the Spec "See and steer the fleet in the new dashboard" and its tickets.

- `dashboard.dc.html`: every screen, with the sample "Acme" world: Overview, Projects, project detail, Agents, agent detail. Click through the sidebar and rows to move between them.
- `logo.dc.html`: the Armada mark.
- `support.js`: the design tool's runtime that renders the two files. It is generated, not part of the product. Do not edit or import it.

Open a file through a local server, since the runtime does not load from `file://`:

```sh
bunx serve design/dashboard-v4
```

Then open `http://localhost:3000/dashboard.dc.html`. The text inside is the source of truth for wording (French). The English strings follow the same meaning. Colors, type (Geist, Geist Mono), spacing and states come from the file's inline styles.

This folder is excluded from lint and from the build.
