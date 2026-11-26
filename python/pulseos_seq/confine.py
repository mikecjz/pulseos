"""Self-confinement of the build process, applied before recipe code runs.

After :func:`confine` returns, this process can:

- read and execute only below the Python installation directories and the given extra paths
  (on macOS also the system library directories, which the dynamic loader needs),
- write only below the given writable directory (plus ``/dev/null``),
- not connect or bind TCP sockets.

Two backends implement this:

- **Linux**: Landlock, which needs ABI >= 4 for the network rules.
- **macOS**: Seatbelt (``sandbox_init``), the kernel sandbox behind App Sandbox. It also blocks
  UDP and spawning other programs.

The restriction cannot be lifted by the process. Where neither backend is available :func:`confine`
raises :class:`ConfinementUnavailable` so the caller fails closed.
"""

from __future__ import annotations

import ctypes
import os
import site
import sys
import sysconfig
from typing import Any

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_ABI1_ALL = (1 << 13) - 1
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_FILE_ONLY = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE
NET_BIND_TCP = 1 << 0
NET_CONNECT_TCP = 1 << 1
MINIMUM_ABI = 4


class ConfinementUnavailable(RuntimeError):
    """No usable sandbox backend on this host, so the build must not run."""


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _libc() -> ctypes.CDLL:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def abi_version() -> int:
    """Landlock ABI version, or 0 when Landlock is unavailable."""
    if sys.platform != "linux":
        return 0
    result = _libc().syscall(SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0),
                             ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))
    return int(result) if result > 0 else 0


def python_read_roots() -> list[str]:
    """Directories the interpreter and installed packages are loaded from."""
    paths = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix,
             sysconfig.get_paths()["stdlib"], sysconfig.get_paths()["platstdlib"], *site.getsitepackages(),
             os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
    return sorted({os.path.realpath(p) for p in paths if p and os.path.exists(p)})


def _check(result: int, what: str) -> None:
    if result < 0:
        error = ctypes.get_errno()
        raise ConfinementUnavailable(f"{what} failed: {os.strerror(error)}")


def available() -> bool:
    """Whether :func:`confine` can confine this process on this host."""
    if sys.platform == "darwin":
        return _sandbox_init() is not None
    return abi_version() >= MINIMUM_ABI


def confine(writable: str, readable: list[str] | None = None) -> dict[str, object]:
    """Restrict this process; returns a description of the confinement for the build model."""
    if sys.platform == "darwin":
        _confine_seatbelt(writable, readable or [])
        return {"mechanism": "seatbelt"}
    return {"mechanism": "landlock", "landlockAbi": _confine_landlock(writable, readable)}


def _confine_landlock(writable: str, readable: list[str] | None) -> int:
    abi = abi_version()
    if abi < MINIMUM_ABI:
        raise ConfinementUnavailable(
            f"Landlock ABI {abi} is too old or unavailable; network confinement needs ABI >= {MINIMUM_ABI}"
            + ("" if sys.platform == "linux" else f" (no sandbox backend for platform {sys.platform!r})"))
    libc = _libc()
    handled_fs = FS_ABI1_ALL | FS_REFER | FS_TRUNCATE
    attr = _RulesetAttr(handled_fs, NET_BIND_TCP | NET_CONNECT_TCP)
    ruleset = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)),
                           ctypes.c_uint32(0))
    _check(ruleset, "landlock_create_ruleset")
    try:
        read = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
        rules = [(p, read) for p in python_read_roots() + [os.path.realpath(p) for p in (readable or [])]]
        rules += [(os.path.realpath(writable), handled_fs), ("/dev/null", FS_READ_FILE | FS_WRITE_FILE)]
        for path, access in rules:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                if not os.path.isdir(path):
                    access &= FS_FILE_ONLY
                rule = _PathBeneathAttr(access, fd)
                _check(libc.syscall(SYS_LANDLOCK_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH),
                                    ctypes.byref(rule), ctypes.c_uint32(0)), f"landlock_add_rule({path})")
            finally:
                os.close(fd)
        _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(PR_SET_NO_NEW_PRIVS)")
        _check(libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0)),
               "landlock_restrict_self")
    finally:
        os.close(ruleset)
    return abi


# macOS Seatbelt. Directories the dynamic loader and libSystem read from; the dyld shared cache lives
# below /System (or a cryptex mounted below /System/Volumes/Preboot), which /System covers.
_DARWIN_SYSTEM_READ = ["/System", "/usr/lib", "/usr/share", "/private/var/db/dyld", "/Library/Apple/System"]
_DARWIN_DEVICES = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]


def _sandbox_init() -> Any:
    """``sandbox_init`` from libSystem, or None when it is missing."""
    try:
        libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        function = libsystem.sandbox_init
    except (OSError, AttributeError):
        return None
    function.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]
    function.restype = ctypes.c_int
    return function


def _sbpl_string(path: str) -> str:
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def seatbelt_profile(writable: str, readable: list[str]) -> str:
    """The Seatbelt (SBPL) profile :func:`confine` applies on macOS."""
    read_roots = python_read_roots() + [os.path.realpath(p) for p in readable]
    system = [p for p in _DARWIN_SYSTEM_READ if os.path.exists(p)]
    read = " ".join(f"(subpath {_sbpl_string(p)})" for p in read_roots + system)
    devices = " ".join(f"(literal {_sbpl_string(p)})" for p in _DARWIN_DEVICES)
    write = f"(subpath {_sbpl_string(os.path.realpath(writable))})"
    return "\n".join([
        "(version 1)",
        "(deny default)",
        # Paths are checked after symlink resolution; stat()/realpath() of any path stays allowed,
        # as with Landlock, which does not mediate metadata.
        "(allow file-read-metadata)",
        f"(allow file-read* {read})",
        f"(allow file-map-executable {read})",
        f"(allow file-read* {devices})",
        "(allow file-write-data (literal \"/dev/null\"))",
        f"(allow file-read* file-write* {write})",
        "(allow sysctl-read)",
        "(allow process-info* (target self))",
        "(allow signal (target self))",
    ]) + "\n"


def _confine_seatbelt(writable: str, readable: list[str]) -> None:
    sandbox_init = _sandbox_init()
    if sandbox_init is None:
        raise ConfinementUnavailable("sandbox_init is not available in libSystem")
    error = ctypes.c_char_p()
    if sandbox_init(seatbelt_profile(writable, readable).encode(), 0, ctypes.byref(error)) != 0:
        message = error.value.decode(errors="replace") if error.value else "unknown error"
        raise ConfinementUnavailable(f"sandbox_init failed: {message}")
