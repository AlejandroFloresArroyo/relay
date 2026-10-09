package expo.modules.relayapkupdate;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
public final class ApkVerificationTest {
  static final String ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  static final String SIGNER = "a".repeat(64);
  static final String OTHER = "b".repeat(64);
  static final String APP = "io.github.fixture.relay";
  static final Runnable OPEN = () -> {};
  static void check(boolean yes, String message) { if (!yes) throw new AssertionError(message); }
  static void rejects(Runnable action, String message) { try { action.run(); } catch (IllegalStateException expected) { return; } throw new AssertionError(message); }
  interface Io { void run() throws IOException; }
  static void rejectsIo(Io action, String message) { try { action.run(); } catch (IllegalStateException | IOException expected) { return; } throw new AssertionError(message); }
  /** Zero bytes without allocating them: the digest buffer stays zero-filled. */
  static InputStream zeros(long length) {
    return new InputStream() {
      long left = length;
      @Override public int read() { if (left == 0) return -1; left--; return 0; }
      @Override public int read(byte[] b, int off, int len) { if (left == 0) return -1; int n = (int) Math.min(len, left); left -= n; return n; }
    };
  }
  public static void main(String[] args) throws Exception {
    // Expected metadata before any byte is accepted.
    ApkVerification.expected(3, 7, ABC, SIGNER);
    rejects(() -> ApkVerification.expected(0, 7, ABC, SIGNER), "empty APK accepted");
    rejects(() -> ApkVerification.expected(ApkVerification.MAX_BYTES + 1, 7, ABC, SIGNER), "APK above 256 MiB accepted");
    ApkVerification.expected(ApkVerification.MAX_BYTES, 7, ABC, SIGNER);
    rejects(() -> ApkVerification.expected(3, 0, ABC, SIGNER), "versionCode 0 accepted");
    rejects(() -> ApkVerification.expected(3, 2147483648L, ABC, SIGNER), "versionCode above Android's int accepted");
    ApkVerification.expected(3, 2147483647L, ABC, SIGNER);
    rejects(() -> ApkVerification.expected(3, 7, ABC.toUpperCase(), SIGNER), "non canonical SHA-256 accepted");
    rejects(() -> ApkVerification.expected(3, 7, ABC.substring(1), SIGNER), "short SHA-256 accepted");
    rejects(() -> ApkVerification.expected(3, 7, ABC, SIGNER + "a"), "long signer digest accepted");

    // Signer: exactly one certificate, never a rotated or multi-signer set.
    byte[] cert = "abc".getBytes(StandardCharsets.US_ASCII);
    check(ApkVerification.signer(false, new byte[][] { cert }).equals(ABC), "signer is not the SHA-256 of its certificate");
    rejects(() -> ApkVerification.signer(true, new byte[][] { cert }), "multiple signers accepted");
    rejects(() -> ApkVerification.signer(false, new byte[][] {}), "missing certificate accepted");
    rejects(() -> ApkVerification.signer(false, new byte[][] { cert, cert }), "two certificates accepted");

    // Installed app: same package, same signer, strictly newer, installs allowed.
    ApkVerification.sameInstalled(APP, 7, SIGNER, APP, 6, SIGNER, true);
    rejects(() -> ApkVerification.sameInstalled("io.github.fixture.other", 7, SIGNER, APP, 6, SIGNER, true), "another package accepted");
    rejects(() -> ApkVerification.sameInstalled(APP, 6, SIGNER, APP, 6, SIGNER, true), "same versionCode accepted");
    rejects(() -> ApkVerification.sameInstalled(APP, 5, SIGNER, APP, 6, SIGNER, true), "downgrade accepted");
    rejects(() -> ApkVerification.sameInstalled(APP, 7, OTHER, APP, 6, SIGNER, true), "different signer accepted");
    rejects(() -> ApkVerification.sameInstalled(APP, 7, SIGNER, APP, 6, SIGNER, false), "update without install permission accepted");

    // Parsed archive must match what was announced.
    ApkVerification.archive(APP, 7, "2.1.0", SIGNER, APP, 7, "2.1.0", SIGNER);
    rejects(() -> ApkVerification.archive(APP, 7, "2.1.0", SIGNER, "io.github.fixture.other", 7, "2.1.0", SIGNER), "archive package mismatch accepted");
    rejects(() -> ApkVerification.archive(APP, 7, "2.1.0", SIGNER, APP, 8, "2.1.0", SIGNER), "archive versionCode mismatch accepted");
    rejects(() -> ApkVerification.archive(APP, 7, "2.1.0", SIGNER, APP, 7, "2.1.1", SIGNER), "archive versionName mismatch accepted");
    rejects(() -> ApkVerification.archive(APP, 7, "2.1.0", SIGNER, APP, 7, null, SIGNER), "archive without versionName accepted");
    rejects(() -> ApkVerification.archive(APP, 7, "2.1.0", SIGNER, APP, 7, "2.1.0", OTHER), "archive signer mismatch accepted");

    // Streaming hash: exact length and digest, copy never beyond the announced length.
    byte[] abc = "abc".getBytes(StandardCharsets.US_ASCII);
    ByteArrayOutputStream copied = new ByteArrayOutputStream();
    ApkVerification.stream(new ByteArrayInputStream(abc), copied, 3, ABC, OPEN);
    check(java.util.Arrays.equals(copied.toByteArray(), abc), "copied bytes changed");
    ApkVerification.stream(new ByteArrayInputStream(abc), null, 3, ABC, OPEN);
    rejectsIo(() -> ApkVerification.stream(new ByteArrayInputStream(abc), null, 4, ABC, OPEN), "stream shorter than announced accepted with a matching hash");
    rejectsIo(() -> ApkVerification.stream(new ByteArrayInputStream("abd".getBytes(StandardCharsets.US_ASCII)), null, 3, ABC, OPEN), "altered bytes accepted");
    rejectsIo(() -> ApkVerification.stream(new ByteArrayInputStream("ab".getBytes(StandardCharsets.US_ASCII)), null, 3, ABC, OPEN), "short stream accepted");
    ByteArrayOutputStream bounded = new ByteArrayOutputStream();
    rejectsIo(() -> ApkVerification.stream(new ByteArrayInputStream("abcd".getBytes(StandardCharsets.US_ASCII)), bounded, 3, ABC, OPEN), "long stream accepted");
    check(bounded.size() <= 3, "copy wrote beyond the announced length");
    String overMax = "da6ce8755151acd05195db67ebce3ee0fb5f4012e71e821cc5750f3304eaf41e";
    rejectsIo(() -> ApkVerification.stream(zeros(ApkVerification.MAX_BYTES + 1), null, ApkVerification.MAX_BYTES + 1, overMax, OPEN), "stream above 256 MiB accepted");
    AtomicInteger checks = new AtomicInteger();
    Runnable retired = () -> { checks.incrementAndGet(); throw new IllegalStateException("retired"); };
    ByteArrayOutputStream late = new ByteArrayOutputStream();
    rejectsIo(() -> ApkVerification.stream(new ByteArrayInputStream(abc), late, 3, ABC, retired), "retired candidate kept streaming");
    check(checks.get() == 1 && late.size() == 0, "a retired candidate copied bytes");
    System.out.println("ApkVerification: metadata / signer / installed / archive / streaming hash GREEN");
  }
}
