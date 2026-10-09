package relay.modules.share;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
public final class SharePolicy {
  public static final int SOURCE_BYTES = 16000000;
  public static void validate(String action, String mime, String text, String uri, boolean granted, int streams, boolean destination) {
    if (!destination || !"android.intent.action.SEND".equals(action)) throw new IllegalArgumentException("unsupported");
    if ("text/plain".equals(mime)) {
      if (uri != null || streams != 0 || text == null || text.isEmpty() || text.length() > 64000 || text.getBytes(StandardCharsets.UTF_8).length > 64000) throw new IllegalArgumentException("unsupported");
      return;
    }
    if (!("image/jpeg".equals(mime) || "image/png".equals(mime) || "image/webp".equals(mime)) || text != null || streams != 1 || !granted || uri == null) throw new IllegalArgumentException("unsupported");
    URI parsed = URI.create(uri);
    if (!"content".equals(parsed.getScheme()) || parsed.getAuthority() == null || parsed.getAuthority().isEmpty() || parsed.getFragment() != null || parsed.getUserInfo() != null) throw new IllegalArgumentException("unsupported");
  }
  public static void dimensions(int width, int height) {
    if (width < 1 || height < 1 || width > 10000 || height > 10000 || (long) width * height > 24000000) throw new IllegalArgumentException("unsupported");
  }
  public static void copy(InputStream input, OutputStream output, int limit, String mime) throws IOException {
    byte[] prefix = new byte[12]; int prefixSize = 0;
    while (prefixSize < prefix.length) {
      int count = input.read(prefix, prefixSize, prefix.length - prefixSize);
      if (count < 0) break;
      if (count == 0) throw new IOException("unsupported");
      prefixSize += count;
    }
    byte[] header = java.util.Arrays.copyOf(prefix, prefixSize);
    String sniff = header.length >= 3 && (header[0]&255) == 255 && (header[1]&255) == 216 && (header[2]&255) == 255 ? "image/jpeg"
      : header.length >= 8 && header[0] == (byte)137 && header[1] == 80 && header[2] == 78 && header[3] == 71 && header[4] == 13 && header[5] == 10 && header[6] == 26 && header[7] == 10 ? "image/png"
      : header.length >= 12 && new String(header, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") && new String(header, 8, 4, StandardCharsets.US_ASCII).equals("WEBP") ? "image/webp" : null;
    if (!mime.equals(sniff) || header.length > limit) throw new IOException("unsupported");
    output.write(header);
    int total = header.length; byte[] chunk = new byte[8192];
    while (true) {
      if (Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
      int count = input.read(chunk, 0, Math.min(chunk.length, limit - total + 1));
      if (count < 0) return;
      if (count == 0) throw new IOException("unsupported");
      total += count;
      if (total > limit) throw new IOException("unsupported");
      output.write(chunk, 0, count);
    }
  }
}
