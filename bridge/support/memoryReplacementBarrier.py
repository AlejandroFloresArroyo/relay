"""Pause only native stdout/fsync boundaries and delay TERM handling; execute the production helper unchanged."""
import os, runpy, signal, stat, sys, time

helper, barrier, stage = sys.argv[1:]
fsync = os.fsync

def pause():
    with open(os.path.join(barrier, 'replacement-ready'), 'w') as marker:
        marker.write(str(os.getpid()))
    deadline = time.monotonic() + 5
    while not os.path.exists(os.path.join(barrier, 'replacement-release')):
        if time.monotonic() >= deadline:
            raise RuntimeError('Synthetic replacement barrier timed out.')
        time.sleep(0.005)

stdout = sys.stdout
class PreparedOutput:
    def write(self, data):
        if stage == 'before' and '"phase": "prepared"' in data: pause()
        return stdout.write(data)
    def flush(self):
        return stdout.flush()

def staged_fsync(fd):
    result = fsync(fd)
    if stage == 'prepared' and stat.S_ISREG(os.fstat(fd).st_mode): pause()
    return result

register = signal.signal
def delayed_term(signum, handler):
    # A loaded machine runs the helper's TERM cleanup well after the signal; model that delay deterministically.
    if signum == signal.SIGTERM and callable(handler):
        return register(signum, lambda s, f: (time.sleep(0.25), handler(s, f)))
    return register(signum, handler)

signal.signal = delayed_term

sys.stdout = PreparedOutput()
os.fsync = staged_fsync
sys.argv = [helper]
runpy.run_path(helper, run_name='__main__')
