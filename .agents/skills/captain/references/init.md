# Mode: `init` — Preflight & Turnkey Project Onboarding

Use this guide when a repo has no `.captain/config.json`, no OpenBoard setup, or no Armada snapshot/sandbox auth yet. Inspect everything yourself first, propose **one concrete plan**, confirm once, and apply.

---

## Step 1: Inspect live tools & repository (in one pass)

1. **CLI & forge preflight:**
   - `ob --version && ob doctor && ob whoami && ob channels` (if missing: `curl -fsSL https://openboard.thevibecompany.co/install.sh | sh`, or `npx -y @the-vibe-company/openboard-cli` on Node >= 22.1).
   - `armada --version` — **must be `>= 14.x`** (older `3.x` binaries use incompatible subcommands; if `< 14` or missing, set `armada_cli` to `npx -y @the-vibe-company/armada@latest`). Then check `armada info --setup`, `armada org list`, `armada snapshot ls`, `armada account ls`, `armada host ls`.
   - `gh auth status` and `git remote get-url origin` + `git symbolic-ref --short refs/remotes/origin/HEAD` (preserve dots in repo names like `next.js` and detect real default branch instead of assuming `main`). If remote is GitLab/Bitbucket, warn upfront that automated PR supervision currently targets GitHub (`gh`).
   - **Reachability check:** Remote Modal sandboxes require an HTTPS `BOARD_URL` reachable from Modal — a local SQLite `ob serve` on `localhost` will fail inside Modal sandboxes.

2. **Repo shape, collaboration & harness readiness:**
   - **Monorepo vs single-repo:** Check workspace files (`pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `go.work`, `Cargo.toml` `[workspace]`, `pyproject.toml` `[tool.uv.workspace]`, `apps/` + `packages/`, `backend/` + `frontend/`). For monorepos, propose scoped `area=` labels and shared append points (manifests, lockfiles, barrel exports).
   - **Solo vs team:** Check `CODEOWNERS` (`.github/` or `.gitlab/`), recent `git shortlog -sn --since="90 days ago"`, and CI workflows (`.github/workflows/`).
     - Solo **with CI** → recommend `auto-merge` (release PRs still always require explicit approval).
     - Team (`CODEOWNERS` / multiple authors) or **zero CI** → recommend `review-gate` or `draft-only`.
   - **Harness readiness:** Note local test/lint/typecheck commands, warn if `AGENTS.md` is missing or > 9 KB, and recommend GitHub Merge Queue if running `>= 4` parallel sandboxes.

3. **Existing code-review & shipping workflow:**
   - Check `.agents/skills/`, `.claude/skills/`, `.codex/skills/`, `.github/workflows/`, and PR templates for `ship-pr-dev`, `review-code-dev`, `code-review`, Cubic, CodeRabbit, or Danger.
   - **Adopt what already exists.** Only if **none exists**, offer to install `ship-pr-dev` (`skillpack install ship-pr-dev --scope project --project <repo-root>`) when `skillpack` has access, or fall back to `"builtin:isolated-review"`. Never modify `ship-pr-dev`.

---

## Step 2: Confirm once

Summarize your findings concisely and confirm:
- Repo shape (`area=` labels), topology & default `merge_mode`, detected `base_branch`.
- OpenBoard board URL, channel (create if missing), scoped worker connection/profile, `## OpenBoard` block for `AGENTS.md`/`CLAUDE.md` (standard vs compact).
- Review workflow (adopted existing tool, or install `ship-pr-dev`, or `builtin:isolated-review`).
- Armada CLI (`>= 14.x` or `npx`), org, provider, and golden snapshot setup (with root+user-safe `ob` install + scoped OpenBoard auth inside the sandbox + quick smoke test).
- `.captain/` gitignore choice: **local** (add `.captain/` to `.git/info/exclude` → `git status` stays 100 % clean) or **shared** (commit only `.captain/config.json` + `.captain/.gitignore` ignoring logs/rules/handoff).

---

## Step 3: Apply after confirmation

1. **OpenBoard setup:**
   - Create channel/board if missing and verify/create a scoped worker connection (keep all connection secrets outside the repo, e.g. `~/.config/openboard/`, mode `600`).
   - Add `## OpenBoard` to `AGENTS.md` / `CLAUDE.md`:

   **Standard (~680 B):**
   ```markdown
   ## OpenBoard

   - Board API: <BOARD_URL> · Default task channel: `<channel>`
   - Verify your identity with `ob whoami`, claim your task with `ob tasks claim <id>`, and read the thread with `ob read <id>`.
   - Renew before lease expiry with `ob tasks renew <id>`.
   - Post progress and the PR URL with `ob reply <id> "<update>"`. Put `OpenBoard #<id>` in the PR body (never `Closes #<id>`).
   - If blocked on a human decision, place the hold yourself with `ob tasks block <id> "<reason>" --kind awaiting_approval`.
   - When all acceptance criteria are verified, run `ob tasks complete <id> "<result>"` under the same profile. Keep all credentials out of tracked files.
   ```

   **Compact (~440 B, for byte-budgeted `AGENTS.md`):**
   ```markdown
   ## OpenBoard
   Board: <BOARD_URL> · Tasks: `<channel>`
   Run `ob whoami`, `ob tasks claim <id>`, `ob read <id>`. Renew with `ob tasks renew <id>`.
   Post progress + PR URL with `ob reply <id> "<update>"`. Use `OpenBoard #<id>` in PR bodies (never `Closes #<id>`).
   If blocked on a human, run `ob tasks block <id> "<reason>" --kind awaiting_approval`.
   When verified, run `ob tasks complete <id> "<result>"` under the same profile. Zero secrets in tracked files.
   ```

2. **Review workflow:** install `ship-pr-dev` if accepted, otherwise keep the adopted workflow.

3. **Armada snapshot & sandbox OpenBoard auth** (if requested):
   - Use a root+user-safe `ob` install in the snapshot `init` script (attach `OPENBOARD_INSTALL_DIR` to `sh`, NOT `curl`):
     ```sh
     if command -v ob >/dev/null 2>&1; then
       ob --version
     elif [ "$(id -u)" -eq 0 ]; then
       curl -fsSL https://openboard.thevibecompany.co/install.sh | OPENBOARD_INSTALL_DIR=/usr/local/bin sh
     else
       curl -fsSL https://openboard.thevibecompany.co/install.sh | sh
     fi
     ```
   - Provision `BOARD_URL` and the scoped worker connection secret via Armada's secret/env store (never baked into the image or git), connect via `ob connect "$BOARD_URL" --as <worker-profile> < "$OPENBOARD_SECRET_FILE"`, smoke-test `ob --version && ob whoami && ob grants explain <channel>`, and stop the smoke sandbox immediately.

4. **Write minimal `.captain/config.json`** (zero secrets):
   ```json
   {
     "repo": "<owner/repo>",
     "base_branch": "<main>",
     "branch_prefix": "captain/",
     "topology": "solo|team",
     "is_monorepo": false,
     "openboard": { "board_url": "<https://...>", "channel": "<channel>" },
     "armada": { "cli": "npx -y @the-vibe-company/armada@latest", "org": "<org-id>", "provider": "modal", "snapshot": "<name>", "max_inflight": 8 },
     "routing": { "builder_models": [], "light_model": "", "challenger_model": "" },
     "delivery": { "review_tool": "<adopted|ship-pr-dev|builtin:isolated-review>", "merge_mode": "review-gate", "max_open_prs": 5, "post_merge_hook": "" },
     "cadence": { "wakeup_seconds": 120, "challenger_every_n_prs": 10 },
     "circuit_breakers": { "max_ttl_extensions": 3, "max_ci_fail_rounds": 3, "max_rebase_rounds": 3 }
   }
   ```
   Configure `.git/info/exclude` (local mode) or `.captain/.gitignore` (shared mode) so runtime files (`orch.log`, `watchdog.pid`, `rules.md`, `HANDOFF.md`) never dirty commits.
