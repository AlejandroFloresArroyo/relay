package expo.modules.relaywidget;

public final class WidgetReadingTest {
  static void check(boolean yes, String message) { if (!yes) throw new AssertionError(message); }
  public static void main(String[] args) {
    long minute = 60_000L;
    long phone = 1_800_000_000_000L;
    // The Puente clock one hour ahead, then one hour behind: only its own durations cross over.
    for (long skew : new long[] { 60 * minute, -60 * minute }) {
      long puente = phone + skew;
      long expiry = WidgetReading.phoneExpiry(puente, puente + 30 * minute, phone);
      check(expiry == phone + 30 * minute, "the Puente clock offset moved the expiry (skew " + skew + "): " + expiry);
      long approval = WidgetReading.phoneExpiry(puente, puente + 2 * minute, phone);
      check(approval == phone + 2 * minute, "an Aprobación deadline crossed with the wrong sign (skew " + skew + ")");
    }
    check(WidgetReading.phoneExpiry(phone, phone, phone) == -1, "a reading that expires when it is taken was accepted");
    check(WidgetReading.phoneExpiry(phone, phone - 1, phone) == -1, "a reading that expired before it was taken was accepted");
    check(WidgetReading.phoneExpiry(phone, phone + 30 * minute + 1, phone) == -1, "a reading longer than the TTL was accepted");

    long observed = phone; long expires = phone + 30 * minute;
    check(WidgetReading.current(phone + minute, observed, expires), "a fresh reading was not current");
    check(!WidgetReading.current(expires, observed, expires), "an expired reading was shown as current");
    check(!WidgetReading.current(expires + 3_600_000L, observed, expires), "an old reading was shown as current");
    check(!WidgetReading.current(observed - 1, observed, expires), "a phone clock moved back made a reading current");

    check(WidgetReading.outcome(200, null) == WidgetReading.Outcome.STORE, "a projection was not stored");
    for (String code : new String[] { "device_revoked", "key_unknown", "unauthorized", "pairing_required" }) {
      check(WidgetReading.outcome(code.equals("device_revoked") ? 403 : 401, code) == WidgetReading.Outcome.FORGET, "a refused device kept the widget: " + code);
    }
    check(WidgetReading.outcome(404, "not_found") == WidgetReading.Outcome.NEUTRAL, "a Puente without the endpoint kept a reading");
    check(WidgetReading.outcome(426, "protocol_upgrade_required") == WidgetReading.Outcome.NEUTRAL, "an incompatible Puente kept a reading");
    check(WidgetReading.outcome(503, "unavailable") == WidgetReading.Outcome.KEEP, "a transient failure erased the dated reading");
    check(WidgetReading.outcome(403, "tailnet_required") == WidgetReading.Outcome.KEEP, "a non-device refusal forgot the Servidor");

    check(WidgetReading.periodicDue(phone + 15 * minute, phone), "the periodic job skipped a stale reading");
    check(!WidgetReading.periodicDue(phone + 5 * minute, phone), "the periodic job fetched right after a push");
    check(WidgetReading.periodicDue(phone - minute, phone), "a phone clock moved back stopped the periodic job");
    System.out.println("WidgetReading: clock, expiry and outcome GREEN");
  }
}
