import hashlib
import runpy
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

seeder = runpy.run_path(str(Path(__file__).resolve().parents[1] / "src" / "modal-artifact-seed.py"))
seed = seeder["seed"]


class Volume:
    def __init__(self, files):
        self.files = files
        self.uploads = []

    def read_file(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        yield self.files[path]

    @contextmanager
    def batch_upload(self, force):
        assert force
        yield self

    def put_file(self, source, path, mode):
        assert mode == 0o444
        path = path.removeprefix("/")
        self.uploads.append(path)
        self.files[path] = source.read_bytes()


class SeedTest(unittest.TestCase):
    def test_only_missing_or_invalid_manifest_digests_are_written(self):
        blobs = [b"warm", b"mend", b"new"]
        pins = [{"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for data in blobs]
        warm, corrupt, missing = [pin["sha256"] for pin in pins]
        volume = Volume({warm: blobs[0], corrupt: b"bad!", "earlier-release": b"preserved"})
        with tempfile.TemporaryDirectory() as directory:
            for pin, data in zip(pins, blobs):
                Path(directory, pin["sha256"]).write_bytes(data)
            seed(volume, directory, pins)
            seed(volume, directory, pins)
        self.assertEqual(volume.uploads, [corrupt, missing])
        self.assertEqual(volume.files, dict(zip((warm, corrupt, missing, "earlier-release"), (*blobs, b"preserved"))))

    def test_seed_creates_volume_only_for_the_immutable_bound_app(self):
        client = object()
        volume = Volume({})
        apps = {"registered": "app-other"}
        created = []

        def app_lookup(name, *, client, environment_name):
            self.assertEqual(environment_name, "main")
            return SimpleNamespace(app_id=apps[name])

        def volume_lookup(name, *, client, environment_name, create_if_missing):
            self.assertTrue(create_if_missing)
            created.append((name, client, environment_name))
            return volume

        modal = SimpleNamespace(
            Client=SimpleNamespace(from_credentials=lambda *_: client),
            App=SimpleNamespace(lookup=app_lookup),
            Volume=SimpleNamespace(from_name=volume_lookup),
        )
        request = dict(
            appId="app-bound", appName="registered", environment="main",
            tokenId="id", tokenSecret="secret", directory="/public", pins=[],
        )
        with self.assertRaisesRegex(ValueError, "binding mismatch"):
            seeder["seed_bound_app"](modal, request)
        self.assertEqual(created, [])
        apps["registered"] = "app-bound"
        seeder["seed_bound_app"](modal, request)
        self.assertEqual(created, [("armada-runtime-artifacts", client, "main")])

    def test_wrong_local_bytes_are_never_uploaded(self):
        pin = {"sha256": hashlib.sha256(b"right").hexdigest(), "bytes": 5}
        volume = Volume({})
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, pin["sha256"]).write_bytes(b"wrong")
            with self.assertRaisesRegex(ValueError, "Invalid local"):
                seed(volume, directory, [pin])
        self.assertEqual(volume.uploads, [])


if __name__ == "__main__":
    unittest.main()
