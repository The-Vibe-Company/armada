"""Run explicitly routed release contracts, rejecting empty or skipped reports."""
import pathlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = sorted(str(p.relative_to(ROOT)) for p in ROOT.glob("packages/*/test/*.release.ts"))
FILES += ["scripts/build-migration.release.ts"]
# Native process/protocol owners stay in PR CI with fake transports, but their
# additional real-binary declarations are required only after the release build.
FILES += [
    "packages/provider-boat/test/native-cwd.test.ts",
    "packages/mcp-server/test/mcp-codex-bridge.test.ts",
]
for source in FILES:
    with tempfile.TemporaryDirectory() as directory:
        report = pathlib.Path(directory) / "contracts.xml"
        subprocess.run([
            "bun", "test", "./" + source, "--reporter=junit",
            "--reporter-outfile=" + str(report),
        ], cwd=ROOT, check=True)
        cases = list(ET.parse(report).getroot().iter("testcase"))
        if not cases or any(any(case.find(tag) is not None for tag in ("failure", "error", "skipped")) for case in cases):
            raise RuntimeError(f"Release contract must execute without skips: {source}")
        print(f"{source}: {len(cases)} executed, zero skipped", flush=True)
