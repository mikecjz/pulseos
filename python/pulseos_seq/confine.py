"""Self-confinement of the build process with Linux Landlock, applied before recipe code runs.

After :func:`confine` returns, this process (and anything it spawns) can:

- read and execute only below the Python installation directories and the given extra paths,
- write only below the given writable directory (plus ``/dev/null``),
- not connect or bind TCP sockets (Landlock ABI >= 4).

The restriction cannot be lifted by the process. It needs Linux with Landlock ABI >= 4; on anything
else :func:`confine` raises :class:`ConfinementUnavailable` so the caller fails closed.
"""

from __future__ import annotations

import ctypes
import os
import site
import sys
import sysconfig

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
    """Landlock with network rules is not available, so the build must not run."""


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


def confine(writable: str, readable: list[str] | None = None) -> int:
    """Restrict this process; returns the Landlock ABI version used."""
    abi = abi_version()
    if abi < MINIMUM_ABI:
        raise ConfinementUnavailable(
            f"Landlock ABI {abi} is too old or unavailable; network confinement needs ABI >= {MINIMUM_ABI}")
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
