package expo.modules.relaynotifications;
import javax.crypto.AEADBadTagException;
/** Pure JVM decision, tested by mobile/plugins/nativeJvm.test.js. */
public final class SnapshotDecryption {
  /**
   * Only a GCM tag mismatch proves the snapshot can never be read (a restored or reinstalled app has
   * a new Keystore key). Any other Keystore error may be transient: keep the snapshot.
   */
  public static boolean discard(Throwable error) { return error instanceof AEADBadTagException; }
}
