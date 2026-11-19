"""Publish only digest-named public server artifacts to a bound Modal environment."""

import hashlib
import os
import stat
import sys
from pathlib import Path


def matches(chunks, pin):
    digest = hashlib.sha256()
    size = 0
    for chunk in chunks:
        size += len(chunk)
        if size > pin["bytes"]:
            return False
        digest.update(chunk)
    return size == pin["bytes"] and digest.hexdigest() == pin["sha256"]


def volume_matches(volume, pin):
    try:
        return matches(volume.read_file(pin["sha256"]), pin)
    except FileNotFoundError:
        return False


def seed(volume, directory, pins):
    for pin in pins:
        if volume_matches(volume, pin):
            continue
        path = Path(directory, pin["sha256"])
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode) or not matches(
                iter(lambda: source.read(1024 * 1024), b""), pin
            ):
                raise ValueError("Invalid local public runtime artifact")
            source.seek(0)
            with volume.batch_upload(force=True) as batch:
                batch.put_file(source, "/" + pin["sha256"], mode=0o444)
        if not volume_matches(volume, pin):
            raise ValueError("Volume runtime artifact verification failed")


if __name__ == "__main__":
    import json

    import modal

    request = json.load(sys.stdin)
    environment = request["environment"]
    with modal.Client.from_credentials(request["tokenId"], request["tokenSecret"]) as client:
        app = modal.App.lookup(request["appName"], environment_name=environment, client=client)
        if app.app_id != request["appId"]:
            raise ValueError("Modal app binding mismatch")
        volume = modal.Volume.from_name(
            "armada-runtime-artifacts",
            environment_name=environment,
            create_if_missing=True,
            client=client,
        )
        seed(volume, request["directory"], request["pins"])
