#!/usr/bin/env bash
# Installs All Eyes On Me (https://github.com/The-Vibe-Company/all-eyes-on-me) at the commit Armada's landing
# runs were made with, outside this repository, as its README's « Try it » does: the `aeom` CLI on the PATH,
# the /aeom and /aeom-judge skills and the aeom-worker / aeom-judge agents for Claude Code. Needs Node 22+,
# pnpm and git. AEOM_HOME picks where it is cloned (~/tools/all-eyes-on-me by default).
set -euo pipefail
COMMIT="${AEOM_COMMIT:-9cd8ecf1d5e8f7ef97a5f8df5afdc8d2896b35c2}"
DIR="${AEOM_HOME:-$HOME/tools/all-eyes-on-me}"
export AEOM_TELEMETRY=0 AEOM_UPDATE_CHECK=0
[ -d "$DIR/.git" ] || git clone https://github.com/The-Vibe-Company/all-eyes-on-me "$DIR"
git -C "$DIR" fetch --quiet origin
git -C "$DIR" checkout --quiet "$COMMIT"
(cd "$DIR" && pnpm install && pnpm build && pnpm --filter @aeom/core exec playwright install chromium)
mkdir -p "$HOME/.local/bin" "$HOME/.claude/skills" "$HOME/.claude/agents"
ln -sfn "$DIR/packages/cli/dist/index.js" "$HOME/.local/bin/aeom"
ln -sfn "$DIR/skills/aeom" "$HOME/.claude/skills/aeom"
ln -sfn "$DIR/skills/aeom-judge" "$HOME/.claude/skills/aeom-judge"
ln -sfn "$DIR/agents/claude/aeom-worker.md" "$HOME/.claude/agents/aeom-worker.md"
ln -sfn "$DIR/agents/claude/aeom-judge.md" "$HOME/.claude/agents/aeom-judge.md"
echo "aeom $(git -C "$DIR" rev-parse --short HEAD) installed; add ~/.local/bin to PATH and restart Claude Code to load the agents."
