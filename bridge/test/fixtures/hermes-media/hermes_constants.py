# Exact AST nodes from Hermes ea114c3e98c3339e13004adfc6098cf28ed7d754; MIT license.
from __future__ import annotations
_profile_fallback_warned: bool = False
_UNSET = object()
_HERMES_HOME_OVERRIDE: ContextVar[str | object] = ContextVar('_HERMES_HOME_OVERRIDE', default=_UNSET)

def get_hermes_home_override() -> str | None:
    """Return the active context-local Hermes home override, if any."""
    override = _HERMES_HOME_OVERRIDE.get()
    return str(override) if override is not _UNSET and override else None

def _expand_hermes_home(path: str) -> Path:
    """Expand environment and user-home syntax in a Hermes home path."""
    return Path(os.path.expanduser(os.path.expandvars(path)))

def _get_platform_default_hermes_home() -> Path:
    """Return the platform default with the literal data-directory suffix."""
    suffix = os.environ.get('HERMES_DATA_DIR_SUFFIX', '')
    if sys.platform == 'win32':
        local_appdata = os.environ.get('LOCALAPPDATA', '').strip()
        base = Path(local_appdata) if local_appdata else Path.home() / 'AppData' / 'Local'
        return base / ('hermes' + suffix)
    return Path.home() / ('.hermes' + suffix)

def _warn_profile_fallback_once() -> None:
    """Warn once when HERMES_HOME is unset but a non-default profile is sticky-active (wrong fallback)."""
    global _profile_fallback_warned
    if _profile_fallback_warned:
        return
    _profile_fallback_warned = True
    try:
        fallback_home = _get_platform_default_hermes_home()
        active_path = fallback_home / 'active_profile'
        active = active_path.read_text(encoding='utf-8').strip() if active_path.exists() else ''
    except (UnicodeDecodeError, OSError):
        active = ''
    if active and active != 'default':
        msg = f'[HERMES_HOME fallback] HERMES_HOME is unset but active profile is {active!r}. Falling back to {fallback_home}, which is the DEFAULT profile — not {active!r}. Any data this process writes will land in the wrong profile. The subprocess spawner should pass HERMES_HOME explicitly (see issue #18594).'
        with contextlib.suppress(Exception):
            sys.stderr.write(msg + '\n')
            sys.stderr.flush()

def get_hermes_home() -> Path:
    """Hermes home: context-local override → ``HERMES_HOME`` env var → platform default."""
    override = get_hermes_home_override()
    if override:
        return _expand_hermes_home(override)
    if not os.environ.get('HERMES_HOME', '').strip():
        _warn_profile_fallback_once()
    return get_process_hermes_home()

def get_process_hermes_home() -> Path:
    """Hermes home of the running process, ignoring task overrides.

    For process-level assets (theme YAML, dashboard plugin manifests) that must stay visible while a
    request is scoped to another profile (e.g. embedded ``/chat`` under ``--open-profile``). Follows
    ``HERMES_HOME`` live on purpose: routed-profile DECISIONS compare against
    :func:`get_routing_process_hermes_home` instead (#119242).
    """
    val = os.environ.get('HERMES_HOME', '').strip()
    return _expand_hermes_home(val) if val else _get_platform_default_hermes_home()
_default_hermes_root_memo: 'tuple[str, str, Path] | None' = None

def get_default_hermes_root(*, home: str | Path | None=None) -> Path:
    """Root of an explicit home, or the process home when none is supplied."""
    global _default_hermes_root_memo
    native_home = _get_platform_default_hermes_home()
    env_home = str(home).strip() if home is not None else os.environ.get('HERMES_HOME', '').strip()
    env_path = _expand_hermes_home(env_home) if env_home else None
    memo_key = (str(native_home), str(env_path) if env_path is not None else '')
    memo = _default_hermes_root_memo
    if memo is not None and memo[:2] == memo_key:
        return memo[2]
    result = native_home
    if env_path is not None:
        try:
            env_path.resolve().relative_to(native_home.resolve())
        except ValueError:
            result = env_path.parent.parent if env_path.parent.name == 'profiles' else env_path
    _default_hermes_root_memo = (*memo_key, result)
    return result

def get_hermes_dir(new_subpath: str, old_name: str, *, home: Path | None=None) -> Path:
    """Resolve a Hermes subdirectory, honouring a populated legacy ``<old_name>/`` (no migration).

    An empty legacy dir does NOT count (install scaffolds, manual mkdir) so it cannot shadow the new path.

    A bare empty ``<old_name>/`` directory does **not** count as "the legacy install is in use" — install
    scaffolds, manual ``mkdir`` work, and cleared-then-abandoned locations all create empty stubs that would
    otherwise silently shadow real data populated at ``<new_subpath>/``. See #27602 for the pairing-store
    regression where a dormant empty ``pairing/`` orphaned approved-user data in ``platforms/pairing/``.
    """
    home = home or get_hermes_home()
    old_path = home / old_name
    return old_path if _legacy_path_has_content(old_path) else home / new_subpath

def _legacy_path_has_content(path: Path) -> bool:
    """True iff *path* is a non-directory file or a populated directory.

    Non-not-found ``OSError`` means "assume occupied" (never orphan legacy data). Symlinks are
    judged on their target; a dangling one does NOT count.
    """
    try:
        st = path.lstat()
        if stat.S_ISLNK(st.st_mode):
            st = path.stat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if not stat.S_ISDIR(st.st_mode):
        return True
    try:
        next(path.iterdir())
    except StopIteration:
        return False
    except OSError:
        pass
    return True
