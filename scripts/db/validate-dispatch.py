"""Validate standalone migration requests before any database connection."""

import os
import re
import sys


def validate(env):
    mode = env.get("MODE", "")
    if mode not in ("migrate", "history", "repair"):
        raise ValueError("Unsupported migration operation")
    if mode == "migrate" and env.get("DRY_RUN") != "true":
        raise ValueError(
            "Standalone production SQL apply is prohibited; use the validated release workflow"
        )
    if mode == "repair":
        if env.get("CONFIRMATION") != "REPAIR PRODUCTION MIGRATION HISTORY":
            raise ValueError("Repair requires REPAIR PRODUCTION MIGRATION HISTORY confirmation")
        if env.get("STATUS") not in ("applied", "reverted"):
            raise ValueError("Repair status must be applied or reverted")
        if not re.fullmatch(r"[0-9]{14}( [0-9]{14})*", env.get("VERSIONS", "")):
            raise ValueError("Repair requires space-separated 14-digit versions")
    required = (
        ("SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD")
        if mode in ("history", "repair")
        else ("SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_ID")
    )
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise ValueError("Missing production environment secret(s): " + ", ".join(missing))


if __name__ == "__main__":
    try:
        validate(os.environ)
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
