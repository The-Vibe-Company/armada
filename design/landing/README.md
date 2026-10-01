# Landing page mockup

The owner's starting point for Armada's public landing page (2026-10-01). It is a base to go beyond, not a spec to copy: see the ticket "Build Armada's landing page".

- `landing.dc.html`: every section, with sample copy built from the README: hero with flying formations, method, live fleet, coordinators and workers, CLI, keys, install.
- `logo.dc.html`: the Armada mark.
- `support.js`: the design tool's generated runtime that renders the two files. It is not part of the product; do not edit or import it.

Serve the folder, since the runtime does not load from `file://`:

```sh
bunx serve design/landing
```

Then open `http://localhost:3000/landing.dc.html`. This folder is excluded from lint and from the build.
