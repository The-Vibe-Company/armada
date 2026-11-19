import { OUTPUT_ARCHIVE_LIMIT, OUTPUT_DIRECTORY, OUTPUT_MAX_ENTRIES } from "./sandbox-output-limits.ts";

export const DOCKER_OUTPUT_DIRECTORY_MISSING = 4;

/** Run only in the official collector image, with the stopped workspace mounted read-only.
 * Python propagates enumeration and read errors to Docker's exit status. Docker's own cp
 * can emit an apparently complete archive after skipping entries that failed to read. */
export const DOCKER_OUTPUT_ARCHIVE = `
import os, stat, sys, tarfile
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open("/", flags)
try:
    for component in ${JSON.stringify(OUTPUT_DIRECTORY.split("/").filter(Boolean))}:
        # A missing directory preserves the last capture. An existing empty directory is a valid capture.
        try:
            child = os.open(component, flags, dir_fd=fd)
        except FileNotFoundError:
            sys.exit(${DOCKER_OUTPUT_DIRECTORY_MISSING})
        os.close(fd)
        fd = child
    root = ${JSON.stringify(OUTPUT_DIRECTORY.split("/").at(-1))}
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        header = tarfile.TarInfo(root + "/")
        header.type = tarfile.DIRTYPE
        archive.addfile(header)
        total = 0
        with os.scandir(fd) as entries:
            for index, entry in enumerate(entries):
                if index >= ${OUTPUT_MAX_ENTRIES}:
                    sys.exit(3)
                if not entry.is_file(follow_symlinks=False):
                    continue
                name = entry.name
                try:
                    name.encode("utf-8")
                except UnicodeEncodeError:
                    continue
                if len(name.encode("utf-16-le")) // 2 > 255 or "\\\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
                    continue
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(file, "rb") as data:
                    info = os.fstat(data.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        sys.exit(3)
                    if info.st_nlink != 1:
                        continue
                    total += info.st_size
                    if total > ${OUTPUT_ARCHIVE_LIMIT}:
                        sys.exit(3)
                    header = tarfile.TarInfo(root + "/" + name)
                    header.size = info.st_size
                    archive.addfile(header, data)
finally:
    os.close(fd)
`;
