"""Reproduce the inert Linux ELF pins; needs clang 18.1.3 and LLVM lld 22.1.6.

Set CLANG and LLD when the tools are not on PATH. No network/download step.
The helper has one operation: print its version/protocol/capabilities then exit.
"""
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent
manifest = {}
with tempfile.TemporaryDirectory() as tmp:
    for target in ['x86_64', 'aarch64']:
        output = pathlib.Path(tmp) / target
        subprocess.run([os.environ.get('CLANG', 'clang'), '--target='+target+'-linux-gnu',
                        '-fuse-ld='+os.environ.get('LLD', 'lld'), '-nostdlib', '-static', '-Os',
                        '-fno-stack-protector', '-fno-ident', '-Wl,--build-id=none',
                        '-Wl,--strip-all', '-Wl,-z,noexecstack', str(root/'helper.c'),
                        '-o', str(output)], check=True)
        data = output.read_bytes()
        manifest[target] = {'digest': hashlib.sha256(data).hexdigest(),
                            'base64': base64.b64encode(data).decode()}
(root/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
