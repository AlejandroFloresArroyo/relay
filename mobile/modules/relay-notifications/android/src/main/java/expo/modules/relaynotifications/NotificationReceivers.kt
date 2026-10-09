package expo.modules.relaynotifications

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import org.json.JSONObject
import java.net.URI

/** Legacy ntfy transport: secret connection token is bound to the explicitly selected distributor. */
class UnifiedPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    synchronized(NotificationStore) { try {
      val token = intent.getStringExtra("token") ?: return
      if (token.toByteArray().size > 100) return
      val entry = NotificationStore.byToken(context, token) ?: return
      val distributor = entry.getString("distributor")
      val uid = context.packageManager.getApplicationInfo(distributor, 0).uid
      if (uid != entry.getInt("distributorUid") || (Build.VERSION.SDK_INT >= 34 && sentFromUid != -1 && sentFromUid != uid)) return
      if (intent.`package` != null && intent.`package` != context.packageName) return
      val messageId = intent.getStringExtra("id")
      if (messageId != null && messageId.toByteArray().size > 100) return
      when (intent.action) {
        "org.unifiedpush.android.connector.NEW_ENDPOINT" -> {
          val endpoint = intent.getStringExtra("endpoint") ?: return
          val url = URI(endpoint)
          if (endpoint.toByteArray().size > 1000 || url.rawUserInfo != null || url.rawFragment != null
            || !url.rawPath.matches(Regex("/up[A-Za-z0-9_-]{8,200}")) || url.rawQuery !in listOf(null, "up=1")) return
          PrivateBridge.validateOrigin("${url.scheme}://${url.rawAuthority}")
          if (entry.optString("endpoint") != endpoint) {
            NotificationStore.clearActions(context, entry.getString("serverId"))
            entry.put("registrationId", JSONObject.NULL).put("generation", entry.getLong("generation") + 1)
            NotificationStore.read(context).getJSONObject("generations").put(entry.getString("serverId"), entry.getLong("generation"))
          }
          entry.put("endpoint", endpoint).put("state", "endpoint"); NotificationStore.save(context)
        }
        "org.unifiedpush.android.connector.MESSAGE" -> {
          val bytes = intent.getByteArrayExtra("bytesMessage") ?: return
          if (bytes.size !in 1..4096) return
          val envelope = JSONObject(String(bytes, Charsets.UTF_8))
          if (envelope.optString("kind") == "widget") {
            // Silent and content-free: "the widget projection changed". Nothing is shown, fetched or stored here.
            if (envelope.keys().asSequence().toSet() != setOf("schema", "kind", "registrationId") || envelope.opt("schema") != 1
              || entry.optString("registrationId") == "null" || envelope.optString("registrationId") != entry.optString("registrationId")
              || !entry.getJSONObject("preferences").optBoolean("enabled")) return
            // An expired enrollment wakes nothing, as for Avisos; the widget then renews only by its job.
            if (NotificationStore.serverTime(context, entry)?.let { entry.optLong("expiresAt") <= it } == true) return
            context.sendBroadcast(Intent(PairedRead.WIDGET_REFRESH).setClassName(context.packageName, PairedRead.WIDGET_PROVIDER)
              .putExtra("serverId", entry.getString("serverId")))
          } else {
            if (envelope.keys().asSequence().toSet() != setOf("schema", "kind", "noticeId", "registrationId", "expiresAt")
              || envelope.opt("schema") != 1 || envelope.optString("kind") !in listOf("approval", "task", "error", "server")
              || !envelope.optString("noticeId").matches(Regex("[a-f0-9-]{36}"))
              || !(envelope.isNull("expiresAt") || envelope.opt("expiresAt") is Number)
              || entry.optString("registrationId") == "null" || envelope.optString("registrationId") != entry.optString("registrationId")
              || !entry.getJSONObject("preferences").optBoolean("enabled") || !entry.getJSONObject("preferences").getJSONObject("types").optBoolean(envelope.getString("kind"))) return
            // No private command is fetched or persisted while receiving a transport message.
            val serverTime = NotificationStore.serverTime(context, entry)
            if (serverTime != null && (entry.optLong("expiresAt") <= serverTime || (!envelope.isNull("expiresAt") && envelope.getLong("expiresAt") <= serverTime))) return
            NotificationUI.show(context, entry, envelope, serverTime == null)
          }
        }
        "org.unifiedpush.android.connector.UNREGISTERED" -> NotificationStore.purge(context, entry.getString("serverId"))
        "org.unifiedpush.android.connector.REGISTRATION_FAILED" -> if (entry.isNull("endpoint")) NotificationStore.purge(context, entry.getString("serverId"))
        "org.unifiedpush.android.connector.TEMP_UNAVAILABLE" -> { entry.put("state", "unavailable"); NotificationStore.save(context) }
        else -> return
      }
      if (messageId != null) RelayNotificationsModule.sendRegistration(context, distributor, "MESSAGE_ACK", token, messageId)
    } catch (_: Exception) { /* Untrusted data and private failures never enter logs. */ } }
  }
}
class NotificationDecisionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != "relay.notifications.DENY" || intent.component?.className != javaClass.name || intent.data != null) return
    val nonce = intent.getStringExtra(NotificationStore.GESTURE_EXTRA) ?: return
    val action: JSONObject
    val scope: JSONObject
    try {
      action = NotificationStore.claim(context, nonce, "deny") ?: return
      if (action.optString("kind") != "approval") return
      scope = NotificationStore.entry(context, action.getString("serverId"))?.let { JSONObject(it.toString()) } ?: return
      if (!NotificationStore.unlocked(context)) return
    } catch (_: Exception) { return }
    val pending = goAsync(); val started = SystemClock.elapsedRealtime()
    Thread {
      fun guard() { check(NotificationStore.unlocked(context) && NotificationStore.current(context, scope) && SystemClock.elapsedRealtime() - started in 0..60000) }
      try {
        guard()
        val path = "/v1/notifications/notices/" + action.getString("noticeId")
        val notice = PrivateBridge.request(context, scope, path, beforeSend = { guard() })
        guard()
        require(notice.optInt("schema") == 1 && notice.optString("noticeId") == action.getString("noticeId") && notice.optString("kind") == "approval"
          && notice.optString("registrationId") == action.getString("registrationId") && notice.optString("state") == "pending")
        val readAt = SystemClock.elapsedRealtime()
        val serverNow = notice.getLong("serverNow")
        require(notice.isNull("expiresAt") || notice.getLong("expiresAt") > serverNow)
        val target = notice.getJSONObject("target"); val approval = notice.getJSONObject("approval")
        require(target.keys().asSequence().toSet() == setOf("agentId", "runId", "approvalId") && target.getString("agentId") == approval.getString("agentId")
          && target.getString("runId") == approval.getString("runId") && target.getString("approvalId") == approval.getString("id"))
        val body = JSONObject().put("schema", 1).put("registrationId", action.getString("registrationId")).put("target", target).put("choice", "deny")
        require(notice.isNull("expiresAt") || serverNow + SystemClock.elapsedRealtime() - readAt < notice.getLong("expiresAt"))
        guard() // Final scope/keyguard check after reading the fresh target and before the POST.
        require(approval.getJSONArray("choices").let { choices -> (0 until choices.length()).any { choices.opt(it) == "deny" } })
        val result = PrivateBridge.request(context, scope, "$path/decision", body) {
          guard()
          require(notice.isNull("expiresAt") || serverNow + SystemClock.elapsedRealtime() - readAt < notice.getLong("expiresAt"))
        }
        guard()
        require(result.optBoolean("ok") && result.optString("outcome") == "rejected")
        NotificationStore.clearActions(context, scope.getString("serverId"), action.getString("tag")); NotificationStore.save(context)
      } catch (_: Exception) {
        try {
          if (NotificationStore.current(context, scope)) NotificationUI.show(context, scope, JSONObject().put("kind", "approval").put("noticeId", action.getString("noticeId"))
            .put("registrationId", action.getString("registrationId")), true, "Decisión sin confirmar. Revisa Relay; no se reenviará.")
        } catch (_: Exception) { /* No retry, queue or private diagnostic. */ }
      } finally { pending.finish() }
    }.apply { isDaemon = true; start() }
  }
}
/** Temporary binding permits the distributor's foreground-importance boost; starts no service loop. */
class NotificationRaiseService : Service() {
  override fun onBind(intent: Intent): IBinder? = if (intent.action == "org.unifiedpush.android.connector.RAISE_TO_FOREGROUND") Binder() else null
}
