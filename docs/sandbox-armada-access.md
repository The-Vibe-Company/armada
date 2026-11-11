# Sandbox Armada access (#983)

## Delivery scope

A normal sandbox may opt into scoped Armada access as its owner. The access
must reuse delegated orchestrator authority, not copy an owner's API token.
It must retain owner/org boundaries, bounded expiry and active-child limits.
The orchestration method belongs in an optional Skillpack skill, not Armada.

Implementation and validation are in progress. This document does not assert
that the staging acceptance scenario has passed.

## Required validation

On staging, for both Modal/Codex and Boat/Codex:

1. Launch an opted-in parent and ask it to launch a child.
2. Message the child, read its answer and stop it.
3. Stop and resume the parent and verify conversation continuity.
4. Verify a parent without the option receives no delegated Armada authority.

No production deployment or migration application is part of this change.
