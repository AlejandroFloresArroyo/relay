package expo.modules.relaynotifications

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Dns
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.net.InetAddress
import java.net.URI
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

internal object PrivateBridge {
  fun validateOrigin(value: String): URI {
    val url = URI(value)
    require(url.scheme in listOf("http", "https") && url.host?.matches(Regex("[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\.ts\\.net")) == true
      && url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null && url.rawPath in listOf("", "/"))
    return url
  }
  private fun tailnet(address: InetAddress): Boolean {
    val bytes = address.address.map { it.toInt() and 255 }
    return if (bytes.size == 4) bytes[0] == 100 && bytes[1] in 64..127 else bytes.size == 16 && bytes.take(6) == listOf(0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0)
  }
  data class Response(val status: Int, val body: JSONObject)
  fun request(context: Context, scope: JSONObject, path: String, body: JSONObject? = null, beforeSend: () -> Unit = {}): JSONObject {
    val response = exchange(context, scope, path, if (body == null) "GET" else "POST", body) {
      check(NotificationStore.unlocked(context) && NotificationStore.current(context, scope)); beforeSend()
    }
    require(response.status in 200..299) { "No se pudo confirmar la Decisión." }
    return response.body
  }
  fun exchange(context: Context, scope: JSONObject, path: String, method: String, body: JSONObject?, beforeSend: () -> Unit): Response =
    exchange(context, scope, path, method, body, beforeSend, object : Dns {
      override fun lookup(host: String): List<InetAddress> =
        CompletableFuture.supplyAsync { InetAddress.getAllByName(host).toList() }.get(750, TimeUnit.MILLISECONDS)
    }, SocketFactory.getDefault())

  // Internal socket boundary for isolated framework instrumentation; never exposed to JS or IPC.
  fun exchange(context: Context, scope: JSONObject, path: String, method: String, body: JSONObject?, beforeSend: () -> Unit, resolver: Dns, sockets: SocketFactory): Response {
    val captured = NotificationStore.captureRevocation(context, scope)
    val origin = validateOrigin(scope.getString("url"))
    val dns = object : Dns { override fun lookup(host: String): List<InetAddress> {
      require(host == origin.host)
      val addresses = resolver.lookup(host)
      require(addresses.isNotEmpty() && addresses.all { tailnet(it) })
      return addresses
    } }
    // OkHttp already ships with React Native/Expo. Its DNS result is used for the actual socket.
    val client = OkHttpClient.Builder().dns(dns).socketFactory(sockets).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
      .addNetworkInterceptor { chain ->
        // DNS/connect may await: no key or decision leaves the socket after revocation or locking.
        beforeSend()
        chain.proceed(chain.request())
      }
      .connectTimeout(1500, TimeUnit.MILLISECONDS).readTimeout(1500, TimeUnit.MILLISECONDS).callTimeout(3, TimeUnit.SECONDS).build()
    val builder = Request.Builder().url(scope.getString("url").trimEnd('/') + path)
      .header("Authorization", "Bearer " + scope.getString("key")).header("X-Relay-Protocol", "2").header("X-Relay-Notifications", "1")
    builder.method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
    client.newCall(builder.build()).execute().use { response ->
      val stream = requireNotNull(response.body).byteStream()
      val output = ByteArrayOutputStream(); val buffer = ByteArray(4096)
      stream.use { input ->
        while (true) { val size = input.read(buffer); if (size < 0) break; require(output.size() + size <= 131072); output.write(buffer, 0, size) }
      }
      val result = JSONObject(output.toString("UTF-8"))
      if (!response.isSuccessful) {
        val code = result.optJSONObject("error")?.optString("code")
        if (code in listOf("device_revoked", "key_unknown", "unauthorized", "pairing_required")) {
          // Do not surface an old authorization refusal to UI cleanup targeting a newer enrollment.
          check(NotificationStore.purgeCaptured(context, captured)) { "Solicitud de Avisos obsoleta." }
        }
      }
      return Response(response.code, result)
    }
  }
}
