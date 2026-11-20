"""Publish only digest-named public server artifacts to a bound Modal environment."""

import hashlib
import os
import stat
import sys
from pathlib import Path


class SeedFailure(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as error:
            raise SeedFailure(13, "Could not open local runtime artifact") from error
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode) or not matches(
                iter(lambda: source.read(1024 * 1024), b""), pin
            ):
                raise SeedFailure(13, "Invalid local public runtime artifact")
            with volume.batch_upload(force=True) as batch:
                batch.put_file(Path(f"/proc/self/fd/{source.fileno()}"), "/" + pin["sha256"], mode=0o444)
        if not volume_matches(volume, pin):
            raise ValueError("Volume runtime artifact verification failed")


def seed_bound_app(modal, request):
    environment = request["environment"]
    try:
        client = modal.Client.from_credentials(request["tokenId"], request["tokenSecret"])
    except Exception as error:
        raise SeedFailure(10, "Modal credential authentication failed") from error
    try:
        app = modal.App.lookup(request["appName"], environment_name=environment, client=client)
    except Exception as error:
        raise SeedFailure(11, "Modal App lookup failed") from error
    if app.app_id != request["appId"]:
        raise SeedFailure(12, "Modal app binding mismatch")
    try:
        volume = modal.Volume.from_name(
            "armada-runtime-artifacts",
            environment_name=environment,
            create_if_missing=True,
            client=client,
        )
        seed(volume, request["directory"], request["pins"])
    except SeedFailure:
        raise
    except Exception as error:
        raise SeedFailure(14, "Modal volume operation failed") from error


if __name__ == "__main__":
    import json

    import modal

    try:
        seed_bound_app(modal, json.load(sys.stdin))
    except SeedFailure as error:
        sys.exit(error.code)
