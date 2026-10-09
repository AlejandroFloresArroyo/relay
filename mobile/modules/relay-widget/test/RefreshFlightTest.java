package expo.modules.relaywidget;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;

public final class RefreshFlightTest {
  static void check(boolean yes, String message) { if (!yes) throw new AssertionError(message); }
  static Thread start(RefreshFlight flight, boolean periodic, RefreshFlight.Read read) {
    Thread thread = new Thread(() -> { try { flight.run(periodic, read); } catch (InterruptedException | RuntimeException ignored) { } });
    thread.setDaemon(true); // a failed check must end the JVM even with a read still held
    thread.start();
    return thread;
  }
  static void await(CountDownLatch latch) { try { latch.await(); } catch (InterruptedException error) { throw new RuntimeException(error); } }

  public static void main(String[] args) throws Exception {
    RefreshFlight flight = new RefreshFlight();
    List<Boolean> reads = Collections.synchronizedList(new ArrayList<>());
    CountDownLatch reading = new CountDownLatch(1), release = new CountDownLatch(1);
    Thread first = start(flight, false, periodic -> { reads.add(periodic); reading.countDown(); await(release); });
    reading.await();
    // The periodic job arrives during the read in flight: it becomes the one pending read.
    Thread pending = start(flight, true, reads::add);
    for (int spins = 0; pending.getState() == Thread.State.NEW || pending.getState() == Thread.State.RUNNABLE; spins++) { check(spins < 2000, "the pending read never waited"); Thread.sleep(1); }
    // A burst of redelivered signals: each folds into the pending read and returns at once.
    for (int signal = 0; signal < 50; signal++) {
      Thread burst = start(flight, false, reads::add);
      burst.join(2000);
      check(!burst.isAlive(), "a coalesced signal waited for the read in flight (signal " + signal + ")");
    }
    check(reads.size() == 1, "a signal read while another read was in flight: " + reads.size() + " reads");
    release.countDown(); first.join(2000); pending.join(2000);
    check(!first.isAlive() && !pending.isAlive(), "the flight never finished");
    check(reads.size() == 2, "a burst of 51 signals made " + reads.size() + " reads instead of 2");
    check(Boolean.FALSE.equals(reads.get(1)), "a push signal folded into a pending periodic run was lost: the job skips its read");

    // A failed read never wedges the flight: the next signal reads again.
    Thread failing = start(flight, false, periodic -> { throw new RuntimeException("network"); });
    failing.join(2000);
    Thread after = start(flight, true, reads::add);
    after.join(2000);
    check(reads.size() == 3 && Boolean.TRUE.equals(reads.get(2)), "a failed read stopped later reads");
    System.out.println("RefreshFlight: one read in flight, one pending, burst coalesced GREEN");
  }
}
