# Exact AST nodes from Hermes ea114c3e98c3339e13004adfc6098cf28ed7d754; MIT license.
from __future__ import annotations
_AUDIO_MIME_TYPES = {'.ogg': 'audio/ogg', '.opus': 'audio/opus', '.mp3': 'audio/mpeg', '.m2a': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/m4a', '.flac': 'audio/flac'}
_AUDIO_EXTS = frozenset(_AUDIO_MIME_TYPES)

def _or_default(thunk, default, exc=(TypeError, ValueError)):
    """``thunk()``, or ``default`` when it raises one of ``exc`` (numeric config/env coercion)."""
    try:
        return thunk()
    except exc:
        return default
IMAGE_CACHE_DIR = get_hermes_dir('cache/images', 'image_cache')
AUDIO_CACHE_DIR = get_hermes_dir('cache/audio', 'audio_cache')
VIDEO_CACHE_DIR = get_hermes_dir('cache/videos', 'video_cache')
DOCUMENT_CACHE_DIR = get_hermes_dir('cache/documents', 'document_cache')
SCREENSHOT_CACHE_DIR = get_hermes_dir('cache/screenshots', 'browser_screenshots')
_HERMES_HOME = get_hermes_home()
_HERMES_ROOT = get_default_hermes_root()
_MEDIA_DELIVERY_CACHE_SUBDIRS = ('images', 'audio', 'videos', 'documents', 'screenshots')
MEDIA_DELIVERY_SAFE_ROOTS = (IMAGE_CACHE_DIR, AUDIO_CACHE_DIR, VIDEO_CACHE_DIR, DOCUMENT_CACHE_DIR, SCREENSHOT_CACHE_DIR, *(_HERMES_HOME / d for d in ('image_cache', 'audio_cache', 'video_cache', 'document_cache', 'browser_screenshots')), *(_HERMES_HOME / 'cache' / d for d in _MEDIA_DELIVERY_CACHE_SUBDIRS))
_MEDIA_DELIVERY_TRUST_RECENT_DEFAULT_SECONDS = 600
_MEDIA_DELIVERY_DENIED_PREFIXES = ('/etc', '/proc', '/sys', '/dev', '/root', '/boot', '/var/log', '/var/lib', '/var/run')
_MEDIA_DELIVERY_DENIED_HOME_SUBPATHS = ('.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config', '.azure', '.gcloud', 'Library/Keychains')

def _sqlite_files(name: str) -> tuple[str, ...]:
    """A SQLite store plus its WAL/SHM/rollback-journal sidecars."""
    return (name, f'{name}-wal', f'{name}-shm', f'{name}-journal')
_ROOT_CREDENTIAL_PATHS = ('.env', 'auth.json', 'auth.lock', 'credentials', 'config.yaml', '.anthropic_oauth.json', 'google_token.json', 'google_oauth_pending.json', os.path.join('auth', 'google_oauth.json'), 'webhook_subscriptions.json', os.path.join('cache', 'bws_cache.json'), os.path.join('cache', 'bws_cache.enc.json'), 'pairing', 'mcp-tokens', 'sessions', 'browser-profile', *_sqlite_files('state.db'), *_sqlite_files('kanban.db'))

def _profile_cache_roots() -> List[Path]:
    """Per-profile cache roots ``<root>/profiles/<name>/cache/{images,...}`` (the static safe
    roots cover only the active HERMES_HOME). Enumerated at check time so profiles created after
    startup count and are allowlisted BEFORE the ``/root`` denylist (HERMES_HOME symlinked).

    ``HERMES_HOME=/opt/data``) while the model emits a profile-scoped path silently fails delivery.
    Enumerated dynamically at check time so profiles created after startup are covered, and so the resolved
    profile path is allowlisted *before* the ``/root`` system denylist is consulted (which otherwise wins
    when HERMES_HOME is symlinked under a denied prefix and $HOME is not that prefix). See issue #31733.
    """
    return [p / 'cache' / subdir for p in _profile_dirs() for subdir in _MEDIA_DELIVERY_CACHE_SUBDIRS]

def _profile_dirs() -> List[Path]:
    """Every ``<root>/profiles/<name>`` directory, read at check time."""
    try:
        return [p for p in (_HERMES_ROOT / 'profiles').iterdir() if p.is_dir()]
    except OSError:
        return []

def _credential_home_roots() -> List[Path]:
    """Every Hermes home whose credential stores the denylist must cover: the ACTIVE home
    (the per-turn HERMES_HOME override under ``gateway.multiplex_profiles``), the shared root
    and every ``<root>/profiles/*``. Enumerated at check time like ``_profile_cache_roots`` on
    the allow side — a denylist frozen at import covers only the launch profile, so a
    ``MEDIA:<root>/profiles/<other>/.env`` emitted in any profile's turn would upload it."""
    return list(dict.fromkeys((get_hermes_home(), _HERMES_ROOT, *_profile_dirs())))

def _kanban_root() -> Path:
    """Kanban is root-shared across profiles by design (``kanban_db.kanban_home``)."""
    return Path(os.environ.get('HERMES_KANBAN_HOME', '').strip() or _HERMES_ROOT).expanduser()

def _kanban_board_dirs() -> List[Path]:
    """Every directory under ``<root>/kanban/boards`` (lax on purpose: the DENY side must catch a
    board whatever its name; the allow side filters further)."""
    with contextlib.suppress(OSError):
        return [p for p in (_kanban_root() / 'kanban' / 'boards').iterdir() if p.is_dir()]
    return []

def _kanban_attachment_roots() -> List[Path]:
    """Return durable Kanban attachment roots without importing kanban_db."""
    override = os.environ.get('HERMES_KANBAN_ATTACHMENTS_ROOT', '').strip()
    if override:
        return [Path(override).expanduser()]
    roots = [_kanban_root() / 'kanban' / 'attachments']
    roots.extend((path / 'attachments' for path in _kanban_board_dirs() if not path.is_symlink() and re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}', path.name) and (path / 'kanban.db').is_file()))
    return roots

def _media_delivery_allowed_roots() -> List[Path]:
    """Return roots from which model-emitted local media may be delivered."""
    from gateway.media_policy import media_delivery_allow_dirs
    operator_roots = (root for chunk in media_delivery_allow_dirs().split(os.pathsep) for raw_root in chunk.split(',') if (root := Path(os.path.expanduser(raw_root.strip()))).is_absolute())
    return [*map(Path, MEDIA_DELIVERY_SAFE_ROOTS), *_profile_cache_roots(), *_kanban_attachment_roots(), *operator_roots]

def _media_delivery_recency_seconds() -> float:
    """Recency window (seconds) for trusting fresh files; 0 = pure-allowlist mode."""
    from gateway.media_policy import media_delivery_trust_recent, media_delivery_trust_recent_seconds
    if not media_delivery_trust_recent():
        return 0.0
    custom = media_delivery_trust_recent_seconds().strip()
    default = float(_MEDIA_DELIVERY_TRUST_RECENT_DEFAULT_SECONDS)
    return _or_default(lambda: max(0.0, float(custom)) if custom else default, default)

def _kanban_board_db_paths() -> List[Path]:
    """Named-board ``kanban.db`` stores (+ sidecars): they sit beside the ATTACHMENTS dir
    ``_kanban_attachment_roots`` allowlists and hold every task, comment and run transcript."""
    return [board / name for board in _kanban_board_dirs() for name in _sqlite_files('kanban.db')]

def _media_delivery_denied_paths() -> List[Path]:
    """Return absolute denylist paths under which delivery is never allowed."""
    home = Path(os.path.expanduser('~'))
    return [*map(Path, _MEDIA_DELIVERY_DENIED_PREFIXES), *(home / sub for sub in _MEDIA_DELIVERY_DENIED_HOME_SUBPATHS), *(r / rel for r in _credential_home_roots() for rel in _ROOT_CREDENTIAL_PATHS), *_kanban_board_db_paths()]

def _resolve_path(path: Path, *, strict: bool=False, expand: bool=False) -> Optional[Path]:
    """``path[.expanduser()].resolve(strict)`` or None when it fails (OSError / RuntimeError /
    ValueError — embedded NUL, symlink loop, undeterminable home, missing file under ``strict``)."""
    try:
        return (path.expanduser() if expand else path).resolve(strict=strict)
    except (OSError, RuntimeError, ValueError):
        return None

def _path_under_denied_prefix(resolved: Path) -> bool:
    """True if ``resolved`` lives under a deny-listed system path — except a denied prefix that
    IS the running user's own home: ``/root`` is listed so a non-root gateway can't deliver
    another user's home, but a root-run gateway's own deliverables live under ``$HOME=/root``.
    Credential sub-dirs (``~/.ssh``, ``~/.hermes/.env``) stay blocked (more-specific entries)."""
    home = _resolve_path(Path(os.path.expanduser('~')))
    for denied in _media_delivery_denied_paths():
        resolved_denied = _resolve_path(denied, expand=True)
        if resolved_denied is None:
            continue
        hit = resolved == resolved_denied or _path_is_within(resolved, resolved_denied)
        if hit and resolved_denied != home:
            return True
    return False

def _file_is_recently_produced(resolved: Path, window_seconds: float) -> bool:
    """True if mtime is within ``window_seconds`` — a session-scoped trust signal: agents
    produce artifacts seconds before sending; pre-existing host files are days/months old."""
    if window_seconds <= 0:
        return False
    try:
        return time.time() - resolved.stat().st_mtime <= window_seconds
    except OSError:
        return False

def _path_is_within(path: Path, root: Path) -> bool:
    with contextlib.suppress(ValueError):
        path.relative_to(root)
        return True
    return False

def validate_media_delivery_path(path: str, session_key: str='') -> Optional[str]:
    """Safe absolute file path for native media delivery, else None. Default: any existing
    regular file outside the credential / system denylist (symmetric with inbound). Strict
    (``HERMES_MEDIA_DELIVERY_STRICT=1``, public bots where prompt injection must not exfiltrate
    host secrets): MUST be under a Hermes cache, an operator root (``HERMES_MEDIA_ALLOW_DIRS``),
    or freshly produced within the recency window. Symlinks are resolved before any check."""
    candidate = _normalize_media_tag_path(path)
    if not candidate:
        return None
    try:
        expanded = Path(os.path.expanduser(candidate))
    except (OSError, RuntimeError, ValueError):
        return None
    if not expanded.is_absolute():
        return None
    resolved = _translate_docker_container_media_path(expanded, session_key=session_key)
    if resolved is None:
        resolved = _resolve_path(expanded, strict=True)
    if resolved is None or not resolved.is_file():
        return None
    for root in _media_delivery_allowed_roots():
        resolved_root = _resolve_path(root, expand=True)
        if resolved_root is not None and _path_is_within(resolved, resolved_root):
            return str(resolved)
    from gateway.media_policy import media_delivery_strict
    if not media_delivery_strict():
        return None if _path_under_denied_prefix(resolved) else str(resolved)
    window = _media_delivery_recency_seconds()
    if window > 0 and (not _path_under_denied_prefix(resolved)) and _file_is_recently_produced(resolved, window):
        return str(resolved)
    return None
MEDIA_DELIVERY_EXTS: Tuple[str, ...] = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.mp3', '.m2a', '.wav', '.ogg', '.opus', '.m4a', '.flac', '.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.epub', '.xlsx', '.xls', '.ods', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.kmz', '.kml', '.geojson', '.gpx', '.pptx', '.ppt', '.odp', '.key', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.apk', '.ipa', '.html', '.htm')
_MEDIA_EXT_ALTERNATION = '|'.join(sorted((e.lstrip('.') for e in MEDIA_DELIVERY_EXTS), key=len, reverse=True))
_MEDIA_CJK_TERMINATORS = '（）〈〉《》：，。；！？、“”‘’【】'
MEDIA_TAG_CLEANUP_RE = re.compile('[`"\'*_]{0,3}MEDIA:\\s*(?P<path>`[^`\\n]+?`|"[^"\\n]+?"|\'[^\'\\n]+?\'|(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:' + _MEDIA_EXT_ALTERNATION + '))(?=[\\s`"\'*_,;:)\\]}\\[' + _MEDIA_CJK_TERMINATORS + ']|MEDIA:|\\.(?:\\s|$)|$)[`"\'*_]{0,3}\\.?', re.IGNORECASE)
MEDIA_EXTENSIONLESS_TAG_RE = re.compile('[`"\'*_]{0,3}MEDIA:\\s*(?P<path>`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|(?:~/|/|[A-Za-z]:[/\\\\])[^\\s\\n`"\']+?)(?=[`"\'\\s,;:)\\]}' + _MEDIA_CJK_TERMINATORS + ']|MEDIA:|$)[`"\'*_]{0,3}\\s*', re.IGNORECASE)

def _match_extensionless_path(scan_text: str, match: 're.Match') -> Optional[Tuple[str, int]]:
    """Extensionless MEDIA tag match -> validated on-disk ``(safe_path, end_offset)`` or None: the
    captured path first, then extended across single spaces (max 8 tokens, never past a newline
    or the next ``MEDIA:``).

    When that fails validation, the candidate is progressively extended forward across single spaces
    (validation-gated, bounded at 8 tokens, never past a newline or a subsequent ``MEDIA:`` keyword) so
    unknown-extension paths containing spaces deliver (#24032). Returns ``(safe_path, end_offset)`` where
    ``end_offset`` is the index in ``scan_text`` just past the matched path, or ``None`` when nothing
    validates.
    """
    path = _normalize_media_tag_path(match.group('path'))
    if not path:
        return None
    safe = validate_media_delivery_path(path)
    if safe:
        return (safe, match.end('path'))
    start = match.start('path')
    segment = scan_text[start:].split('\n', 1)[0]
    nxt = segment.find('MEDIA:', 1)
    if nxt != -1:
        segment = segment[:nxt]
    pos = match.end('path') - start
    for _ in range(8):
        token = re.match('[ \\t]*[^ \\t]+', segment[pos:])
        if not token:
            break
        tok_end = pos + token.end()
        safe = validate_media_delivery_path(_normalize_media_tag_path(segment[:tok_end]))
        if safe:
            return (safe, start + tok_end)
        pos = tok_end
    return None

def _normalize_media_tag_path(raw: str) -> str:
    path = str(raw or '').strip()
    if len(path) >= 2 and path[0] == path[-1] and (path[0] in '`"\''):
        path = path[1:-1].strip()
    return path.lstrip('`"\'').rstrip('`"\',.;:)}]')

def _path_lacks_deliverable_extension(path: str) -> bool:
    """True when ``path`` has no extension or one outside MEDIA_DELIVERY_EXTS — such paths
    take the validated delivery pass so nonexistent / denylisted ones stay visible.

    ``path`` — either the basename has no extension at all (Caddyfile, Makefile, …) or the extension is not
    in MEDIA_DELIVERY_EXTS (.py, .log, .weirdext, …). Such paths route through the validated delivery pass
    (``validate_media_delivery_path``) instead of the unconditional one, so every file type is deliverable
    (#36060) while nonexistent / denylisted paths stay visible in the text.
    """
    return Path(path).suffix.lower() not in MEDIA_DELIVERY_EXTS
_TERMINAL_SENTINEL = '<|eos|>'

def _terminal_sentinel_start(text: str) -> int:
    """Offset where the run of exact ``<|eos|>`` tokens closing ``text`` (trailing whitespace
    ignored) begins, else -1; the run ends at ``len(text.rstrip())``."""
    end = start = len(text.rstrip())
    while start >= len(_TERMINAL_SENTINEL) and text[start - len(_TERMINAL_SENTINEL):start] == _TERMINAL_SENTINEL:
        start -= len(_TERMINAL_SENTINEL)
    return start if start < end else -1

def _mask_media_scan_text(text: str) -> str:
    """Offset-preserving mask of protected spans (code, quotes, JSON string values) and of a
    terminal ``<|eos|>`` sentinel, so a tag glued to it ends on whitespace like any other.
    BasePlatformAdapter is defined later in this module; resolved at call time."""
    A = BasePlatformAdapter
    masked = A._mask_json_string_media(A._mask_protected_spans(text))
    start = _terminal_sentinel_start(text)
    if start >= 0:
        masked = _blank_spans(masked, [(start, len(text.rstrip()))])
    return masked

def _deliverable_tag_spans(text: str) -> list:
    """Spans to delete from ``text``: its deliverable MEDIA tags (located on the masked copy)
    plus a terminal ``<|eos|>`` sentinel, which is a control token and never user content."""
    spans = _real_media_tag_spans(_mask_media_scan_text(text))
    start = _terminal_sentinel_start(text)
    if spans and start >= 0:
        spans.append((start, len(text.rstrip())))
    return spans

def _extensionless_media_matches(masked: str):
    """Yield ``(match, safe_path, end_offset)`` for every extension-less / unknown-extension
    MEDIA tag in ``masked`` that ``validate_media_delivery_path`` accepts."""
    for match in MEDIA_EXTENSIONLESS_TAG_RE.finditer(masked):
        path = _normalize_media_tag_path(match.group('path'))
        if path and _path_lacks_deliverable_extension(path):
            resolved = _match_extensionless_path(masked, match)
            if resolved is not None:
                yield (match, resolved[0], resolved[1])

def _real_media_tag_spans(masked: str) -> list:
    """(start, end) spans of deliverable MEDIA tags on a masked copy: known-extension tags
    unconditionally, extension-less / unknown ones only if validate_media_delivery_path accepts."""
    spans: list = [m.span() for m in MEDIA_TAG_CLEANUP_RE.finditer(masked)]
    spans.extend(((match.start(), end) for match, _, end in _extensionless_media_matches(masked)))
    return spans
_FENCED_CODE_RE = re.compile('```[^\\n]*\\n.*?```', re.DOTALL)
_INLINE_CODE_RE = re.compile('`[^`\\n]+`')

def _blank_spans(text: str, spans: list) -> str:
    """Replace every non-newline char inside ``spans`` with a space (offsets preserved)."""
    chars = list(text)
    for start, end in spans:
        chars[start:end] = [c if c == '\n' else ' ' for c in chars[start:end]]
    return ''.join(chars)

def _delete_spans(text: str, spans: list) -> str:
    """Delete ``spans`` from ``text``, merging overlapping/nested ones first so multi-pattern
    matches over the same tag never double-delete adjacent text."""
    if not spans:
        return text
    merged: list = []
    for s, e in sorted(spans):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    chars = list(text)
    for start, end in reversed(merged):
        del chars[start:end]
    return ''.join(chars)

class BasePlatformAdapter:

    @staticmethod
    def _mask_protected_spans(content: str) -> str:
        """Blank fenced code, inline code and blockquotes (length-preserving so regex offsets stay
        valid) against MEDIA: false positives; backtick-quoted paths inside MEDIA: tags stay
        scannable."""
        spans: list = [m.span() for m in _FENCED_CODE_RE.finditer(content)]
        for m in _INLINE_CODE_RE.finditer(content):
            start = m.start()
            if re.search('MEDIA:\\s*$', content[max(0, start - 20):start]):
                continue
            inner = m.group(0)[1:-1].strip()
            if inner.upper().startswith('MEDIA:'):
                candidate = _normalize_media_tag_path(inner[6:])
                if candidate and validate_media_delivery_path(candidate):
                    continue
            spans.append((start, m.end()))
        spans.extend((m.span() for m in re.finditer('^>.*$', content, re.MULTILINE)))
        return _blank_spans(content, spans)

    @staticmethod
    def _mask_json_string_media(content: str) -> str:
        """Blank ``MEDIA:<bare-path>`` tags inside JSON string *values* (stored tool-result text
        like ``{"result": "MEDIA:/x/stale.png"}``) so they are never re-delivered. Only
        value-context strings (``:,{[`` before the ``"``) and bare paths (``/``, ``~/``, ``X:\\``)
        count; ``MEDIA:"..."`` quoted tags and line-start/prose tags are untouched. Offsets
        preserved.

        Here the ``MEDIA:`` is part of stored text, not an outbound directive, but the bare-path branch of
        ``MEDIA_TAG_CLEANUP_RE`` would still match it and re-deliver a stale file. (Regression report
        #34375.)
        """
        if '"' not in content or 'MEDIA:' not in content:
            return content
        spans = [m.span(1) for m in re.finditer('(?<=[:,{\\[])\\s*"((?:[^"\\\\\\n]|\\\\.)*)"', content) if re.search('MEDIA:\\s*(?:~/|/|[A-Za-z]:[/\\\\])', m.group(1))]
        return _blank_spans(content, spans)

    @staticmethod
    def extract_media(content: str) -> Tuple[List[Tuple[str, bool]], str]:
        """Extract ``MEDIA:<path>`` tags and strip ``[[audio_as_voice]]`` / ``[[as_document]]`` ->
        ``([(path, is_voice), ...], cleaned)``. Both directives are message-global;
        ``[[as_document]]`` (unmodified sendDocument for large images) is detected by dispatch sites
        on the ORIGINAL response and only stripped here."""
        media = []
        has_voice_tag = '[[audio_as_voice]]' in content
        cleaned = content.replace('[[audio_as_voice]]', '').replace('[[as_document]]', '')
        scan_content = _mask_media_scan_text(content)
        seen_paths: set = set()

        def _add(path: str) -> None:
            if path not in seen_paths:
                seen_paths.add(path)
                media.append((path, has_voice_tag and os.path.splitext(path)[1].lower() in _AUDIO_EXTS))
        for match in MEDIA_TAG_CLEANUP_RE.finditer(scan_content):
            path = _normalize_media_tag_path(match.group('path'))
            if path:
                try:
                    _add(os.path.expanduser(path))
                except (OSError, RuntimeError, ValueError):
                    continue
        for _, safe_path, _ in _extensionless_media_matches(scan_content):
            _add(safe_path)
        if media:
            spans = _deliverable_tag_spans(cleaned)
            if spans:
                cleaned = re.sub('\\n{3,}', '\n\n', _delete_spans(cleaned, spans)).strip()
        return (media, cleaned)
