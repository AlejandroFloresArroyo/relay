package expo.modules.relaywidget;

/**
 * One widget read in flight and at most one pending. A signal that finds a read already pending returns
 * at once: that read starts after it and covers it. A burst of N signals costs two reads, and no caller
 * (a receiver's goAsync, the job) waits for more than the read in flight plus its own. Android-free so
 * the JVM test runs it.
 */
final class RefreshFlight {
  interface Read { void run(boolean periodic); }
  private boolean running, waiting, waitingPeriodic;

  void run(boolean periodic, Read read) throws InterruptedException {
    synchronized (this) {
      if (waiting) { waitingPeriodic &= periodic; return; } // A push folded into a pending periodic run must still read.
      if (running) {
        waiting = true; waitingPeriodic = periodic;
        try { while (running) wait(); } finally { waiting = false; }
        periodic = waitingPeriodic;
      }
      running = true;
    }
    try { read.run(periodic); } finally { synchronized (this) { running = false; notifyAll(); } }
  }
}
