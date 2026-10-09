package expo.modules.relaynotifications

import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Bundle
import okhttp3.Dns
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import javax.net.SocketFactory

/** Synthetic library test APK only: no network, user keyguard, JUnit or external services. */
class NotificationResidualInstrumentation : Instrumentation() {
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
  override fun onStart() {
    val results = Bundle(); var failures = 0; var passed = 0
    val cases = listOf("replaced_pairing", "renewed_registration", "renewed_ui_registration", "returned_pairing", "current_refusal", "cache_identity")
    try {
      check(context.packageName == "expo.modules.relaynotifications.qa")
      check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      check(context.applicationInfo.uid == android.os.Process.myUid())
      for (name in cases) {
        try { if (name == "cache_identity") cacheIdentity() else refusal(name); passed++; sendStatus(0, Bundle().apply { putString("case", name); putString("result", "PASS") }) }
        catch (_: Throwable) { failures++; sendStatus(0, Bundle().apply { putString("case", name); putString("result", "FAIL") }) }
      }
    } catch (_: Throwable) { failures++; results.putString("fixture", "REFUSED") }
    results.putInt("passed", passed); results.putInt("failures", failures)
    finish(if (failures == 0) android.app.Activity.RESULT_OK else android.app.Activity.RESULT_CANCELED, results)
  }
  private fun cacheIdentity() {
    check(notificationKeyIdentity("fixture-key-A") == "ea65e24b7bc530aafa8a4241fa66d999a69db15eb14e740588c44ad7c8e8ee29")
    check(notificationKeyIdentity("fixture-key-A") != notificationKeyIdentity("synthetic-key-only-replacement"))
    check(runCatching { notificationKeyIdentity("") }.isFailure)
    check(runCatching { notificationKeyIdentity("x".repeat(4097)) }.isFailure)
  }
  private fun pairing(key: String = "synthetic-old-key") = JSONObject().put("serverId", "qa-server")
    .put("url", "http://bridge.fixture.ts.net:8651").put("deviceId", "synthetic-device").put("key", key)
  private fun enroll(scope: JSONObject, registration: String): JSONObject {
    val entry = NotificationStore.begin(context, scope, "qa.synthetic.distributor", 12345)
    entry.put("registrationId", registration).put("state", "registered")
    NotificationStore.save(context)
    return JSONObject(entry.toString())
  }
  private fun refusal(name: String) {
    val original = pairing(); NotificationStore.reconcile(context, JSONArray().put(original))
    val oldEntry = enroll(original, "synthetic-old-registration")
    // UI requests capture pairings; headless requests carry enrollment generation as well.
    val scope = if (name == "renewed_registration") oldEntry else NotificationStore.capturePairing(context, original)
    var replacement: JSONObject? = null; var reads = 0
    val output = ByteArrayOutputStream()
    val socket = MemorySocket(output) {
      reads++
      when (name) {
        "replaced_pairing" -> {
          val next = pairing("synthetic-new-key"); NotificationStore.reconcile(context, JSONArray().put(next))
          replacement = enroll(next, "synthetic-new-registration")
        }
        "renewed_registration", "renewed_ui_registration" -> replacement = enroll(original, "synthetic-new-registration")
        "returned_pairing" -> {
          NotificationStore.reconcile(context, JSONArray().put(pairing("synthetic-intermediate-key")))
          NotificationStore.reconcile(context, JSONArray().put(original))
          replacement = enroll(original, "synthetic-returned-registration")
        }
      }
    }
    val factory = object : SocketFactory() {
      override fun createSocket(): Socket = socket
      override fun createSocket(host: String, port: Int): Socket = error("Unexpected real socket")
      override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = error("Unexpected real socket")
      override fun createSocket(host: InetAddress, port: Int): Socket = error("Unexpected real socket")
      override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = error("Unexpected real socket")
    }
    val dns = object : Dns {
      override fun lookup(host: String): List<InetAddress> = listOf(InetAddress.getByAddress(byteArrayOf(100, 70, 0, 1)))
    }
    val response = runCatching { PrivateBridge.exchange(context, scope, "/v1/notifications", "GET", null, {}, dns, factory) }
    check(reads == 1)
    if (name == "current_refusal") check(response.getOrThrow().status == 403) else check(response.isFailure)
    check(output.toString("UTF-8").startsWith("GET /v1/notifications HTTP/1.1"))
    val current = NotificationStore.entry(context, "qa-server")
    if (name == "current_refusal") check(current == null) else {
      check(current != null && NotificationStore.current(context, requireNotNull(replacement)))
      check(current.getString("registrationId") == replacement!!.getString("registrationId"))
    }
  }
  private class MemorySocket(private val output: ByteArrayOutputStream, beforeRead: () -> Unit) : Socket() {
    private var connected = false; private var ended = false
    private val bytes = "{\"error\":{\"code\":\"device_revoked\"}}".toByteArray(Charsets.UTF_8)
    private val response = ByteArrayInputStream(("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: "+bytes.size+"\r\nConnection: close\r\n\r\n").toByteArray()+bytes)
    private var first = true
    private val input = object : InputStream() {
      private fun boundary() { if (first) { first = false; beforeRead() } }
      override fun read(): Int { boundary(); return response.read() }
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int { boundary(); return response.read(buffer, offset, length) }
    }
    override fun connect(endpoint: SocketAddress?, timeout: Int) { check(endpoint is InetSocketAddress); connected = true }
    override fun getInputStream(): InputStream = input
    override fun getOutputStream() = output
    override fun setSoTimeout(timeout: Int) {}
    override fun getSoTimeout(): Int = 0
    override fun setTcpNoDelay(on: Boolean) {}
    override fun isConnected(): Boolean = connected
    override fun isClosed(): Boolean = ended
    override fun isInputShutdown(): Boolean = ended
    override fun isOutputShutdown(): Boolean = ended
    override fun close() { ended = true }
    override fun getInetAddress(): InetAddress = InetAddress.getByAddress(byteArrayOf(100, 70, 0, 1))
    override fun getPort(): Int = 8651
  }
}
