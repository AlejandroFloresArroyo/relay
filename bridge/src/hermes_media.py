"""Pinned Hermes media functions with read-only process boundaries and typed stdout."""
import ast
import __future__
from contextvars import ContextVar
import contextlib
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import stat
import time
import typing
from pathlib import Path
import sys
import types

EXPECTED = {
    'gateway/platforms/base.py': '48425a540a7b07bae75fdae2c27051f0485a2154b33efc4d492f2660a0344929',
    'gateway/media_policy.py': '471b89948d577bd5c117710a0f05824031a6e069262a9ad9443e08227f0f990d',
    'hermes_constants.py': '1bef6b1066658264d513ad6e1a34ab2a29465eb0fdda6e2359166f42c48fb2f5',
}


def read_config(home):
    # Never import Hermes config loaders: even load_config_readonly initializes homes/backups.
    import yaml

    def read(path):
        try:
            with path.open(encoding='utf-8-sig') as stream:
                content = stream.read(1_048_577)
                if len(content) > 1_048_576:
                    raise ValueError('Media configuration is too large')
                data = yaml.safe_load(content)
        except FileNotFoundError:
            return {}
        if data is None:
            return {}
        if not isinstance(data, dict):
            raise ValueError('Configuration must be a mapping')
        return data

    config = read(home / 'config.yaml')
    managed = Path(os.environ.get('HERMES_MANAGED_DIR', '').strip() or '/etc/hermes')
    overlay = read(managed / 'config.yaml') if managed.is_dir() else {}
    result = {}
    for section in ('gateway', 'terminal'):
        local, locked = config.get(section, {}), overlay.get(section, {})
        if not isinstance(local, dict) or not isinstance(locked, dict):
            raise ValueError('Configuration section must be a mapping')
        keys = ('strict', 'trust_recent_files', 'media_delivery_allow_dirs', 'trust_recent_files_seconds') if section == 'gateway' else ('backend', 'docker_volumes')
        result[section] = {key: locked.get(key, local.get(key)) for key in keys if key in local or key in locked}
    gateway = result['gateway']
    for key in ('strict', 'trust_recent_files'):
        if key in gateway and not isinstance(gateway[key], bool):
            raise ValueError('Media flag must be boolean')
    allow_dirs = gateway.get('media_delivery_allow_dirs', [])
    if not isinstance(allow_dirs, str) and not (isinstance(allow_dirs, list) and all(isinstance(value, str) for value in allow_dirs)):
        raise ValueError('Media allowlist must be paths')
    # A profile reference cannot resolve against another profile's inherited credentials.
    if '${' in json.dumps(gateway):
        raise ValueError('Unresolved media configuration reference')
    terminal = result['terminal']
    if terminal.get('backend', 'local') != 'local' or terminal.get('docker_volumes') or os.environ.get('TERMINAL_ENV', 'local') != 'local' or os.environ.get('TERMINAL_DOCKER_VOLUMES'):
        raise ValueError('Only host-local media is supported')
    return result


def protect_process():
    attempted = [False]
    denied = {'os.mkdir', 'os.remove', 'os.rmdir', 'os.rename', 'os.chmod', 'os.chown', 'os.link', 'os.symlink', 'os.truncate', 'os.utime', 'os.system', 'os.fork', 'os.exec', 'os.posix_spawn', 'subprocess.Popen', 'os.kill', 'os.killpg', 'socket.__new__', 'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.sendto', 'socket.connect', 'socket.bind'}
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

    def audit(event, args):
        writing = event == 'open' and ((isinstance(args[1], str) and any(mode in args[1] for mode in 'wax+')) or isinstance(args[2], int) and args[2] & write_flags)
        env_read = event == 'open' and isinstance(args[0], (str, bytes)) and Path(os.fsdecode(args[0])).resolve().name == '.env'
        if event in denied or writing or env_read:
            attempted[0] = True
            raise PermissionError('Read-only media operation')

    sys.addaudithook(audit)
    return attempted


BASE_NODES = frozenset('AUDIO_CACHE_DIR DOCUMENT_CACHE_DIR IMAGE_CACHE_DIR MEDIA_DELIVERY_EXTS MEDIA_DELIVERY_SAFE_ROOTS MEDIA_EXTENSIONLESS_TAG_RE MEDIA_TAG_CLEANUP_RE SCREENSHOT_CACHE_DIR VIDEO_CACHE_DIR _AUDIO_EXTS _AUDIO_MIME_TYPES _FENCED_CODE_RE _HERMES_HOME _HERMES_ROOT _INLINE_CODE_RE _MEDIA_CJK_TERMINATORS _MEDIA_DELIVERY_CACHE_SUBDIRS _MEDIA_DELIVERY_DENIED_HOME_SUBPATHS _MEDIA_DELIVERY_DENIED_PREFIXES _MEDIA_DELIVERY_TRUST_RECENT_DEFAULT_SECONDS _MEDIA_EXT_ALTERNATION _ROOT_CREDENTIAL_PATHS _TERMINAL_SENTINEL _blank_spans _credential_home_roots _delete_spans _deliverable_tag_spans _extensionless_media_matches _file_is_recently_produced _kanban_attachment_roots _kanban_board_db_paths _kanban_board_dirs _kanban_root _mask_media_scan_text _match_extensionless_path _media_delivery_allowed_roots _media_delivery_denied_paths _media_delivery_recency_seconds _normalize_media_tag_path _or_default _path_is_within _path_lacks_deliverable_extension _path_under_denied_prefix _profile_cache_roots _profile_dirs _real_media_tag_spans _resolve_path _sqlite_files _terminal_sentinel_start validate_media_delivery_path'.split())
CONSTANT_NODES = frozenset('_UNSET _HERMES_HOME_OVERRIDE _profile_fallback_warned _default_hermes_root_memo _expand_hermes_home _get_platform_default_hermes_home _warn_profile_fallback_once get_hermes_home_override get_hermes_home get_process_hermes_home get_default_hermes_root get_hermes_dir _legacy_path_has_content'.split())
POLICY_NODES = frozenset('_FLAG_ENVS _ALLOW_DIRS_ENV _TRUST_RECENT_SECONDS_ENV _TRUTHY _routed_gateway_cfg media_delivery_strict media_delivery_allow_dirs media_delivery_trust_recent media_delivery_trust_recent_seconds _load_gateway_cfg _set_env_default _allow_dirs_str apply_media_policy_env'.split())
METHODS = frozenset(('extract_media', '_mask_protected_spans', '_mask_json_string_media'))


def node_names(node):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return {child.id for target in targets for child in ast.walk(target) if isinstance(child, ast.Name)}
    return set()


def load_selected(source, filename, allowed, namespace, include_methods=False):
    # Whole-file hashes are checked before this seam. Never execute module imports or initializers.
    tree = ast.parse(source[filename].decode('utf-8'), filename=filename)
    selected = []
    found = set()
    for node in tree.body:
        names = node_names(node)
        if names & allowed:
            selected.append(node)
            found.update(names & allowed)
        elif include_methods and isinstance(node, ast.ClassDef) and node.name == 'BasePlatformAdapter':
            methods = [child for child in node.body if isinstance(child, ast.FunctionDef) and child.name in METHODS]
            if {method.name for method in methods} != METHODS:
                raise ValueError('Incompatible media methods')
            # Keep the exact static method bodies/decorators; discard unrelated adapter inheritance.
            selected.append(ast.ClassDef(name=node.name, bases=[], keywords=[], body=methods, decorator_list=[]))
            found.add('BasePlatformAdapter')
    expected = allowed | ({'BasePlatformAdapter'} if include_methods else set())
    if found != expected:
        raise ValueError('Incompatible media dependencies')
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, filename, 'exec', flags=__future__.annotations.compiler_flag), namespace)
    return namespace


def load_media_functions(source, config):
    common = {**vars(typing), 'os': os, 'sys': sys, 'Path': Path, 'ContextVar': ContextVar, 'stat': stat, 'contextlib': contextlib, 're': re, 'time': time, 'logger': logging.getLogger('relay-media')}
    constants = types.ModuleType('hermes_constants')
    constants.__dict__.update(common)
    load_selected(source, 'hermes_constants.py', CONSTANT_NODES, constants.__dict__)
    sys.modules['hermes_constants'] = constants
    policy = types.ModuleType('gateway.media_policy')
    policy.__dict__.update(common)
    load_selected(source, 'gateway/media_policy.py', POLICY_NODES, policy.__dict__)
    sys.modules['gateway.media_policy'] = policy
    policy.apply_media_policy_env(config)
    namespace = {**common, 'get_hermes_home': constants.get_hermes_home, 'get_hermes_dir': constants.get_hermes_dir, 'get_default_hermes_root': constants.get_default_hermes_root,
                 # Configuration already rejects container/remote backends. No host path translates.
                 '_translate_docker_container_media_path': lambda candidate, session_key='': None}
    load_selected(source, 'gateway/platforms/base.py', BASE_NODES, namespace, include_methods=True)
    return namespace['BasePlatformAdapter'].extract_media, namespace['validate_media_delivery_path']


def run():
    attempted = protect_process()
    source = Path(sys.argv[1]).resolve(strict=True)
    home = Path(sys.argv[2])
    if sys.prefix == sys.base_prefix:
        raise RuntimeError('An installed Hermes environment is required')
    verified_source = {filename: (source / filename).read_bytes() for filename in EXPECTED}
    for filename, digest in EXPECTED.items():
        if hashlib.sha256(verified_source[filename]).hexdigest() != digest:
            raise RuntimeError('Incompatible media source')
    os.environ['HERMES_HOME'] = str(home)
    logging.disable(logging.CRITICAL)
    request = json.load(sys.stdin)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        config = read_config(home)
        seconds = config['gateway'].get('trust_recent_files_seconds')
        if seconds is not None:
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds < 0:
                raise ValueError('Media recency must be nonnegative')
            os.environ.setdefault('HERMES_MEDIA_TRUST_RECENT_SECONDS', str(seconds))
        extract_media, validate_media_delivery_path = load_media_functions(verified_source, config)
        if request['operation'] == 'extract':
            result = []
            for message in request['messages']:
                media, cleaned = extract_media(message['text'])
                for candidate, _ in media:
                    result.append({'messageId': message['id'], 'path': candidate, 'displayText': cleaned})
        else:
            candidate = request['path']
            raw = Path(candidate)
            if not raw.is_absolute() or '..' in raw.parts:
                result = {'error': 'blocked'}
            else:
                try:
                    before = raw.stat()
                except FileNotFoundError:
                    result = {'error': 'missing'}
                else:
                    safe = validate_media_delivery_path(candidate)
                    if safe is None:
                        result = {'error': 'blocked'}
                    else:
                        target = Path(safe)
                        after = target.stat()
                        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
                            result = {'error': 'blocked'}
                        else:
                            result = {'path': str(target), 'name': target.name, 'mimeType': mimetypes.guess_type(target.name)[0] or 'application/octet-stream', 'size': after.st_size,
                                      'identity': {'dev': str(after.st_dev), 'ino': str(after.st_ino), 'mtimeNs': str(after.st_mtime_ns), 'ctimeNs': str(after.st_ctime_ns)}}
    if attempted[0]:
        raise PermissionError('A media dependency attempted a forbidden operation')
    return result


def main():
    try:
        result = run()
    except Exception:
        result = {'error': 'unavailable'}
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
