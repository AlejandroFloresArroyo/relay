package expo.modules.relaynotifications

import android.content.Context
import org.json.JSONObject

/**
 * The widget module's only door to a Puente: one GET /v1/widget with the paired key already held in
 * the encrypted snapshot (its Keystore key needs no user authentication, so it opens in background).
 * The key never leaves this module.
 */
object PairedRead {
  const val WIDGET_REFRESH = "expo.modules.relaywidget.REFRESH"
  const val WIDGET_PROVIDER = "expo.modules.relaywidget.RelayWidgetProvider"
  class Response(val status: Int, val body: JSONObject)

  /** Null when this phone no longer holds that pairing (removed, revoked or replaced). */
  fun widget(context: Context, serverId: String, deviceId: String, url: String): Response? {
    val paired = synchronized(NotificationStore) {
      NotificationStore.read(context).getJSONObject("pairings").optJSONObject(serverId)?.let { JSONObject(it.toString()) }
    } ?: return null
    if (paired.optString("deviceId") != deviceId || paired.optString("url") != url) return null
    val response = PrivateBridge.exchange(context, paired, "/v1/widget", "GET", null) { check(NotificationStore.pairingCurrent(context, paired)) }
    return Response(response.status, response.body)
  }
}
