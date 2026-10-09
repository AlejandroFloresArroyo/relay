package expo.modules.relaywidget;

/** Pure decisions over a GET /v1/widget reading; Android-free so the JVM test runs them. */
public final class WidgetReading {
  private WidgetReading() {}
  /** protocol/widget.ts WIDGET_OBSERVATION_TTL_MS: the Puente never promises a longer reading. */
  static final long TTL_MS = 30 * 60_000L;
  /** The periodic job only reads when nothing (a push) renewed the reading this recently. */
  static final long PERIODIC_SKIP_MS = 14 * 60_000L;
  public enum Outcome { STORE, NEUTRAL, FORGET, KEEP }

  /**
   * Phone-clock expiry of a reading. Only the Puente's own duration (expiresAt - observedAt) crosses
   * over, anchored at the phone instant the request started: clock offset between the two machines
   * cancels out, and the anchor is never later than the reading. -1 when the reading is not valid.
   */
  public static long phoneExpiry(long puenteObservedAt, long puenteExpiresAt, long phoneRequestStart) {
    long duration = puenteExpiresAt - puenteObservedAt;
    return duration <= 0 || duration > TTL_MS ? -1 : phoneRequestStart + duration;
  }

  /** A reading is current only from the phone instant it was taken until its expiry. */
  public static boolean current(long now, long observedAt, long expiresAt) {
    return observedAt <= now && now < expiresAt;
  }

  /** The same refusals that retire a notification enrollment retire the widget's Servidor. */
  public static Outcome outcome(int status, String code) {
    if (status == 200) return Outcome.STORE;
    if ((status == 401 || status == 403) && code != null
      && (code.equals("device_revoked") || code.equals("key_unknown") || code.equals("unauthorized") || code.equals("pairing_required"))) return Outcome.FORGET;
    // A Puente without the endpoint, or with another protocol: the widget is a neutral shortcut.
    if (status == 404 || status == 426) return Outcome.NEUTRAL;
    return Outcome.KEEP;
  }

  public static boolean periodicDue(long now, long fetchedAt) {
    return now < fetchedAt || now - fetchedAt >= PERIODIC_SKIP_MS;
  }
}
