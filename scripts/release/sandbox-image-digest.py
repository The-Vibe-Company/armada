"""Read an existing release digest; only an authenticated registry 404 means absent."""
import base64
import json
import os
import re
import urllib.error
import urllib.request

repository = "the-vibe-company/armada-sandbox"
version = os.environ["VERSION"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
    raise SystemExit("Invalid release version")
credential = base64.b64encode(
    (os.environ["GITHUB_ACTOR"] + ":" + os.environ["GHCR_TOKEN"]).encode()
).decode()
request = urllib.request.Request(
    "https://ghcr.io/token?service=ghcr.io&scope=repository:" + repository + ":pull",
    headers={"Authorization": "Basic " + credential},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.load(response)["token"]
    request = urllib.request.Request(
        "https://ghcr.io/v2/" + repository + "/manifests/" + version,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": ", ".join([
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            ]),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            digest = response.headers.get("Docker-Content-Digest", "")
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise ValueError("Invalid registry digest")
            print(digest)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        # Empty stdout is the sole absent-image result.
except Exception:
    # Never include HTTP bodies, headers or credential-bearing request objects.
    raise SystemExit("Could not resolve the release image; refusing to overwrite it.") from None
