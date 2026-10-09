package expo.modules.relayapkupdate;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;
/** Pure APK checks: Android supplies the facts, these decide. Tested by mobile/plugins/nativeJvm.test.js. */
public final class ApkVerification {
  public static final long MAX_BYTES = 268435456L;
  private static final Pattern HEX64 = Pattern.compile("[a-f0-9]{64}");
  private static void check(boolean yes) { if (!yes) throw new IllegalStateException("Invalid APK"); }
  private static MessageDigest sha256() {
    try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }
  static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) out.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
    return out.toString();
  }
  /** Announced metadata, before a private file exists. */
  public static void expected(long byteLength, long versionCode, String sha256, String signerSha256) {
    check(byteLength >= 1 && byteLength <= MAX_BYTES && versionCode >= 1 && versionCode <= 2147483647L);
    check(HEX64.matcher(sha256).matches() && HEX64.matcher(signerSha256).matches());
  }
  /** One signing certificate only; its SHA-256 identifies the signer. */
  public static String signer(boolean multipleSigners, byte[][] certificates) {
    check(!multipleSigners && certificates.length == 1);
    return hex(sha256().digest(certificates[0]));
  }
  /** An update must be this app, signed by the installed signer, strictly newer, with installs allowed. */
  public static void sameInstalled(String applicationId, long versionCode, String signerSha256, String packageName, long installedVersionCode, String installedSigner, boolean canInstall) {
    check(applicationId.equals(packageName) && versionCode > installedVersionCode);
    check(signerSha256.equals(installedSigner) && canInstall);
  }
  /** The parsed archive must be exactly what was announced. */
  public static void archive(String applicationId, long versionCode, String versionName, String signerSha256, String archivePackage, long archiveVersionCode, String archiveVersionName, String archiveSigner) {
    check(applicationId.equals(archivePackage) && versionCode == archiveVersionCode && versionName.equals(archiveVersionName) && signerSha256.equals(archiveSigner));
  }
  /**
   * Hashes the stream, copying to {@code output} when given, and accepts only the announced length and
   * SHA-256. {@code guard} runs before every read so a retired candidate stops at once.
   */
  public static void stream(InputStream input, OutputStream output, long byteLength, String sha256, Runnable guard) throws IOException {
    check(byteLength >= 1 && byteLength <= MAX_BYTES);
    MessageDigest digest = sha256(); byte[] buffer = new byte[65536]; long read = 0;
    while (true) {
      guard.run();
      int count = input.read(buffer);
      if (count < 0) break;
      read += count;
      check(read <= byteLength);
      digest.update(buffer, 0, count);
      if (output != null) output.write(buffer, 0, count);
    }
    check(read == byteLength && hex(digest.digest()).equals(sha256));
  }
}
