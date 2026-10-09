"""Descriptor-relative profile I/O. No Hermes imports, shell, or diagnostic contents.

Lock contract: tools/memory_tool_store.py at ea114c3e98c3339e13004adfc6098cf28ed7d754.
The process owns flock through the retention handshake and atomic replacement.
"""
import os, sys, json, stat, hashlib, base64, fcntl, uuid, signal

MAX = 1024 * 1024
class Failure(Exception):
    pass

def fail(code='unavailable'):
    raise Failure(code)

def cancel(signum, frame):
    fail('cancelled')

signal.signal(signal.SIGTERM, cancel)

def directory(fd, owned=True):
    s = os.fstat(fd)
    if not stat.S_ISDIR(s.st_mode) or (owned and (s.st_uid != os.getuid() or s.st_mode & 0o022)):
        fail()
    return (s.st_dev, s.st_ino)

def root_chain(root):
    if not os.path.isabs(root) or os.path.normpath(root) != root:
        fail()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in root.split('/')[1:]:
            next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        directory(fd)
        return fd
    except BaseException:
        os.close(fd); raise

def child(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        directory(fd)
        return fd
    except BaseException:
        os.close(fd); raise

def check_file(s):
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_mode & 0o022 or s.st_size > MAX:
        fail()

def read(parent, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return {'bytes': '', 'identity': None, 'exists': False}
    try:
        before = os.fstat(fd); check_file(before)
        raw = bytearray()
        while len(raw) <= MAX:
            chunk = os.read(fd, min(65536, MAX + 1 - len(raw)))
            if not chunk: break
            raw.extend(chunk)
        after = os.fstat(fd); check_file(after)
        if len(raw) > MAX or (before.st_mtime_ns, before.st_ctime_ns, before.st_size) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size): fail('conflict')
        bytes(raw).decode('utf-8', 'strict')
        identity = [str(n) for n in (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_mtime_ns, after.st_ctime_ns, after.st_size)]
        return {'bytes': base64.b64encode(raw).decode('ascii'), 'identity': identity, 'exists': True}
    finally:
        os.close(fd)

def limits(config, external):
    unknown = {'memory': None, 'user': None, 'context': None, 'writable': False}
    if external or not config['exists']: return unknown
    try:
        import yaml
        from yaml.nodes import MappingNode, ScalarNode
        from yaml.tokens import AnchorToken, AliasToken
        text = base64.b64decode(config['bytes']).decode('utf-8-sig')
        if '${' in text or any(isinstance(t, (AnchorToken, AliasToken)) for t in yaml.scan(text)): return unknown
        node = yaml.compose(text)
        def check(n, depth=0):
            if depth > 32: fail()
            if isinstance(n, MappingNode):
                keys = set()
                for k, v in n.value:
                    if not isinstance(k, ScalarNode) or k.value in keys: fail()
                    keys.add(k.value); check(v, depth+1)
            elif isinstance(getattr(n, 'value', None), list):
                for v in n.value: check(v, depth+1)
        check(node)
        data = yaml.safe_load(text)
        if not isinstance(data, dict): return unknown
        memory = data.get('memory', {})
        if not isinstance(memory, dict): return unknown
        m, u = memory.get('memory_char_limit', 2200), memory.get('user_char_limit', 1375)
        context = data.get('context_file_max_chars')
        if not all(type(n) is int and 0 <= n <= 100000000 for n in (m, u)): return unknown
        if context is not None and (type(context) is not int or context <= 0 or context > 100000000): return unknown
        return {'memory': m, 'user': u, 'context': context, 'writable': True}
    except Exception:
        return unknown

def run(r):
    profile = r['profile']
    import re
    if not isinstance(profile, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', profile): fail()
    bucket = r['bucket']
    if bucket not in ('memory', 'user', 'soul'): fail('invalid')
    fds = []
    def keep(fd): fds.append(fd); return fd
    root = keep(root_chain(r['home'])); parent = root
    if profile != 'default': parent = keep(child(keep(child(root, 'profiles')), profile))
    profile_fd = parent
    missing_directory = False
    if bucket != 'soul':
        try: parent = keep(child(parent, 'memories'))
        except FileNotFoundError: missing_directory = True
    name = {'memory': 'MEMORY.md', 'user': 'USER.md', 'soul': 'SOUL.md'}[bucket]
    def external():
        return r['external'] or os.path.lexists(r['managedFile'])
    def snapshot():
        config = read(profile_fd, 'config.yaml')
        source = {'bytes': '', 'identity': None, 'exists': False} if missing_directory else read(parent, name)
        effective = limits(config, external())
        chain = [directory(fd) for fd in fds]
        revision = hashlib.sha256(json.dumps([profile, bucket, chain, source, config, effective], sort_keys=True).encode()).hexdigest()
        descriptors = [{'fd': fd, 'identity': [str(n) for n in (os.fstat(fd).st_dev, os.fstat(fd).st_ino, os.fstat(fd).st_uid, os.fstat(fd).st_mode)]} for fd in fds]
        lock_identity = None if lock is None else [str(os.fstat(lock).st_dev), str(os.fstat(lock).st_ino)]
        return {**source, 'revision': revision, 'limits': effective, 'config': config, 'directories': descriptors, 'lockIdentity': lock_identity}
    lock = None
    temp = None
    committed = False
    try:
        if r['write']:
            if missing_directory: fail('read_only')
            lock = os.open(name+'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            check_file(os.fstat(lock))
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: fail('busy')
        before = snapshot()
        if not r['write']: return before
        if before['revision'] != r['revision']: fail('conflict')
        if not before['limits']['writable'] or (not before['exists'] and bucket != 'soul'): fail('read_only')
        print(json.dumps({'phase': 'retain', 'snapshot': before}), flush=True)
        command = json.loads(sys.stdin.readline(MAX * 2 + 4096))
        raw = base64.b64decode(command['bytes'], validate=True)
        if len(raw) > MAX: fail('invalid')
        raw.decode('utf-8', 'strict')
        temp = '.relay-memory-'+str(uuid.uuid4())+'.tmp'
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as out:
                out.write(raw); out.flush(); os.fsync(fd)
        finally: os.close(fd)
        # Reopen the public descriptor chain after retention: detached/renamed profiles cannot win.
        check_root = root_chain(r['home'])
        try:
            check_parent = check_root
            opened = []
            if profile != 'default':
                check_parent = child(check_parent, 'profiles'); opened.append(check_parent)
                check_parent = child(check_parent, profile); opened.append(check_parent)
            if bucket != 'soul':
                check_parent = child(check_parent, 'memories'); opened.append(check_parent)
            if directory(check_parent) != directory(parent): fail('conflict')
        finally:
            for item in reversed(opened): os.close(item)
            os.close(check_root)
        if snapshot()['revision'] != before['revision']: fail('conflict')
        locked = os.stat(name+'.lock', dir_fd=parent, follow_symlinks=False)
        if (locked.st_dev, locked.st_ino) != (os.fstat(lock).st_dev, os.fstat(lock).st_ino): fail('conflict')
        staged = read(parent, temp)
        print(json.dumps({'phase': 'prepared', 'bucket': bucket, 'pid': os.getpid(), 'dirFd': parent,
            'directoryIdentity': before['directories'][-1]['identity'], 'temp': temp,
            'tempIdentity': staged['identity'], 'revision': before['revision'],
            'lockIdentity': before['lockIdentity']}), flush=True)
        # Node performs the guarded synchronous replacement through this live descriptor.
        acknowledgement = json.loads(sys.stdin.readline(4096))
        if acknowledgement != {'committed': True}: fail('invalid')
        temp = None; committed = True
        os.fsync(parent)
        after = snapshot()
        if base64.b64decode(after['bytes']) != raw: fail('uncertain')
        return after
    except BaseException:
        if committed: fail('uncertain')
        raise
    finally:
        if temp:
            try: os.unlink(temp, dir_fd=parent)
            except OSError: pass
        if lock is not None: os.close(lock)
        for fd in reversed(fds): os.close(fd)

try:
    request = json.loads(sys.stdin.readline(8192))
    print(json.dumps({'snapshot': run(request)}), flush=True)
except Failure as e:
    print(json.dumps({'error': 'agent_memory_'+str(e)}), flush=True)
except BaseException:
    print(json.dumps({'error': 'agent_memory_unavailable'}), flush=True)
