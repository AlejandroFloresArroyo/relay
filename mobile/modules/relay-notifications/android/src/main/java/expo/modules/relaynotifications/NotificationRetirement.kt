package expo.modules.relaynotifications

import android.content.Context
import org.json.JSONObject

/** A terminal authorization fact may retire metadata while hidden; it never carries private data. */
internal fun notificationTerminalFailure(context: Context, captured: JSONObject, response: PrivateBridge.Response): JSONObject? {
  val code = response.body.optJSONObject("error")?.optString("code")
  if (response.status in 200..299 || code !in listOf("device_revoked", "key_unknown", "unauthorized", "pairing_required")) return null
  synchronized(NotificationStore) {
    val id = captured.getString("serverId")
    check(NotificationStore.pairingCurrent(context, captured)
      && NotificationStore.generation(context, id) == captured.getLong("revocationGeneration") + 1
      && NotificationStore.entry(context, id) == null)
    return JSONObject().put("error", JSONObject().put("code", code))
  }
}
