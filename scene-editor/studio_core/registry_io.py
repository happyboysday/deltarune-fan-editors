"""Publish a complete PNG before publishing its registry record."""
from contextlib import contextmanager
import os
from pathlib import Path
import tempfile


@contextmanager
def registry_write(lock_file):
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    # A scene window and a chapter window can share the same data directory.
    with lock_file.open("a+b") as lock:
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield  # Closing the file also releases the OS lock after an exception.


def publish(path, contents):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        pending = Path(handle.name)
    try:
        if isinstance(contents, bytes):
            pending.write_bytes(contents)
        else:
            pending.write_text(contents, encoding="utf8")
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)
