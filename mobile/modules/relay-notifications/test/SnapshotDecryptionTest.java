package expo.modules.relaynotifications;
import java.security.*;
import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
public final class SnapshotDecryptionTest {
  static void check(boolean yes, String message) { if (!yes) throw new AssertionError(message); }
  public static void main(String[] args) {
    check(SnapshotDecryption.discard(new AEADBadTagException()), "a key that cannot authenticate the snapshot kept it forever");
    check(!SnapshotDecryption.discard(new UnrecoverableKeyException()), "a transient Keystore error erased the snapshot");
    check(!SnapshotDecryption.discard(new KeyStoreException()), "an unavailable Keystore erased the snapshot");
    check(!SnapshotDecryption.discard(new InvalidKeyException()), "an invalid key erased the snapshot");
    check(!SnapshotDecryption.discard(new BadPaddingException()), "a non-tag padding error erased the snapshot");
    check(!SnapshotDecryption.discard(new GeneralSecurityException()), "a generic security error erased the snapshot");
    System.out.println("SnapshotDecryption: discard only on AEADBadTagException GREEN");
  }
}
