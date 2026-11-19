import hashlib
import runpy
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

seed = runpy.run_path(str(Path(__file__).resolve().parents[1] / "src" / "modal-artifact-seed.py"))["seed"]


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
        self.files[path] = source.read()


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
