package relay.modules.share;
import java.io.*;
import java.util.*;
public final class SharePolicyTest {
  static void check(boolean yes, String message) { if (!yes) throw new AssertionError(message); }
  static void rejects(Runnable action, String message) { try { action.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    SharePolicy.validate("android.intent.action.SEND", "text/plain", "https://literal.invalid", null, false, 0, true);
    rejects(() -> SharePolicy.validate("android.intent.action.SEND_MULTIPLE", "image/jpeg", null, "content://fixture/one", true, 1, true), "multiple action accepted");
    rejects(() -> SharePolicy.validate("android.intent.action.SEND", "image/jpeg", null, "file:///secret", true, 1, true), "external file accepted");
    rejects(() -> SharePolicy.validate("android.intent.action.SEND", "image/jpeg", null, "content://fixture/one", false, 1, true), "missing grant accepted");
    rejects(() -> SharePolicy.validate("android.intent.action.SEND", "image/jpeg", null, "content://fixture/one", true, 2, true), "extra streams accepted");
    rejects(() -> SharePolicy.validate("android.intent.action.SEND", "text/plain", "literal", null, false, 0, false), "wrong destination accepted");
    rejects(() -> SharePolicy.validate("android.intent.action.SEND", "text/plain", "é".repeat(32001), null, false, 0, true), "oversize text accepted");
    byte[] jpeg = new byte[] {(byte)255,(byte)216,(byte)255,0,1};
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    SharePolicy.copy(new ByteArrayInputStream(jpeg), output, 10, "image/jpeg"); check(Arrays.equals(jpeg, output.toByteArray()), "valid bytes changed");
    try { SharePolicy.copy(new ByteArrayInputStream(jpeg), new ByteArrayOutputStream(), 4, "image/jpeg"); throw new AssertionError("stream limit ineffective"); } catch (IOException expected) {}
    try { SharePolicy.copy(new ByteArrayInputStream(jpeg), new ByteArrayOutputStream(), 10, "image/png"); throw new AssertionError("MIME mismatch accepted"); } catch (IOException expected) {}
    try { SharePolicy.copy(new ByteArrayInputStream("secret".getBytes()), new ByteArrayOutputStream(), 10, "image/jpeg"); throw new AssertionError("non image accepted"); } catch (IOException expected) {}
    byte[] large = new byte[20]; System.arraycopy(jpeg, 0, large, 0, jpeg.length);
    ByteArrayOutputStream bounded = new ByteArrayOutputStream();
    try { SharePolicy.copy(new ByteArrayInputStream(large), bounded, 16, "image/jpeg"); throw new AssertionError("large stream accepted"); } catch (IOException expected) {}
    check(bounded.size() <= 16, "stream wrote beyond its limit");
    rejects(() -> SharePolicy.dimensions(10000, 10000), "pixel limit ineffective");
    SharePolicy.dimensions(4000, 3000);
    System.out.println("SharePolicy: action / destination / URI grant / bounded copy / MIME sniff / dimensions GREEN");
  }
}
