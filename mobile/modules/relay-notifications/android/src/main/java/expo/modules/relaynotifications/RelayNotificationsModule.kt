package expo.modules.relaynotifications

import android.Manifest
import android.app.BroadcastOptions
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.interfaces.permissions.Permissions
import org.json.JSONObject

class RelayNotificationsModule : Module() {
  private var pendingOpen: Intent? = null
  private val requestGeneration = java.util.concurrent.atomic.AtomicLong(0)
  private val context get() = requireNotNull(appContext.reactContext)
  private fun checkedScope(raw: String): JSONObject = JSONObject(raw).also {
    require(it.getString("serverId").length in 1..255 && it.getString("deviceId").isNotEmpty() && it.getString("key").isNotEmpty())
    PrivateBridge.validateOrigin(it.getString("url"))
  }
  override fun definition() = ModuleDefinition {
    Name("RelayNotifications")
    Function("cacheIdentity") { key: String -> notificationKeyIdentity(key) }
    OnNewIntent { intent -> pendingOpen = intent }
    Function("permission") { context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() }
    AsyncFunction("requestPermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT >= 33) Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.POST_NOTIFICATIONS)
      else promise.resolve(mapOf("granted" to context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()))
    }
    Function("distributors") {
      context.packageManager.queryBroadcastReceivers(Intent("org.unifiedpush.android.distributor.REGISTER"), 0)
        .filter { it.activityInfo.exported && it.activityInfo.enabled }
        .map { mapOf("packageName" to it.activityInfo.packageName, "label" to it.loadLabel(context.packageManager).toString()) }.distinctBy { it["packageName"] }
    }
    OnActivityEntersBackground { requestGeneration.incrementAndGet() }
    Function("invalidateRequests") { requestGeneration.incrementAndGet(); Unit }
    Function("reconcile") { raw: String -> NotificationStore.reconcile(context, org.json.JSONArray(raw)) }
    AsyncFunction("request") { raw: String, method: String, path: String, body: String?, promise: Promise ->
      val input = checkedScope(raw)
      val captured = NotificationStore.captureRevocation(context, input)
      val generation = requestGeneration.get()
      val allowed = (method == "GET" && (path == "/v1/notifications" || path.matches(Regex("/v1/notifications/notices/[A-Za-z0-9-]{1,1000}"))))
        || (method in listOf("PUT", "DELETE") && path == "/v1/notifications/registration")
        || (method == "POST" && path.matches(Regex("/v1/notifications/notices/[A-Za-z0-9-]{1,1000}/decision")))
      require(allowed)
      Thread {
        try {
          val guard = {
            check(requestGeneration.get() == generation && NotificationStore.pairingCurrent(context, captured)
              && NotificationStore.generation(context, captured.getString("serverId")) == captured.getLong("revocationGeneration")
              && NotificationStore.unlocked(context) && appContext.currentActivity?.hasWindowFocus() == true)
          }
          guard()
          val response = PrivateBridge.exchange(context, captured, path, method, body?.let { JSONObject(it) }, guard)
          val terminal = notificationTerminalFailure(context, captured, response)
          // Only a scoped, content-free terminal refusal crosses a later blur/lock generation.
          if (terminal == null) guard()
          promise.resolve(mapOf("status" to response.status, "body" to (terminal ?: response.body).toString()))
        } catch (_: Exception) { promise.reject("notifications_transport", "No se pudo confirmar la solicitud de Avisos.", null) }
      }.apply { isDaemon = true; start() }
    }
    Function("status") { id: String -> NotificationStore.status(context, id) }
    Function("begin") { raw: String, distributor: String ->
      val input = checkedScope(raw)
      NotificationStore.capturePairing(context, input)
      val old = NotificationStore.entry(context, input.getString("serverId"))?.let { JSONObject(it.toString()) }
      if (old != null) sendRegistration(context, old.getString("distributor"), "UNREGISTER", old.getString("token"))
      val receivers = context.packageManager.queryBroadcastReceivers(Intent("org.unifiedpush.android.distributor.REGISTER").setPackage(distributor), 0)
      require(receivers.any { it.activityInfo.exported && it.activityInfo.enabled })
      val uid = context.packageManager.getApplicationInfo(distributor, 0).uid
      val entry = NotificationStore.begin(context, input, distributor, uid)
      sendRegistration(context, distributor, "REGISTER", entry.getString("token"))
      NotificationStore.status(context, input.getString("serverId"))
    }
    Function("commit") { id: String, generation: Long, raw: String -> synchronized(NotificationStore) {
      val status = JSONObject(raw); val entry = requireNotNull(NotificationStore.entry(context, id))
      check(entry.getLong("generation") == generation && entry.optString("endpoint") != "null")
      val registration = status.optJSONObject("registration")
      NotificationStore.clearActions(context, id)
      entry.put("registrationId", registration?.getString("id") ?: JSONObject.NULL).put("expiresAt", registration?.getLong("expiresAt") ?: 0)
        .put("serverNow", status.getLong("serverNow")).put("checkedElapsed", android.os.SystemClock.elapsedRealtime())
        .put("bootCount", android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.BOOT_COUNT, -1))
        .put("preferences", status.getJSONObject("preferences")).put("state", if (registration == null) "disabled" else "registered")
      NotificationStore.save(context)
    } }
    Function("forget") { id: String ->
      val old = NotificationStore.entry(context, id)?.let { JSONObject(it.toString()) }
      NotificationStore.purge(context, id)
      if (old != null) sendRegistration(context, old.getString("distributor"), "UNREGISTER", old.getString("token"))
    }
    Function("forgetIfCurrent") { raw: String, expected: Long -> synchronized(NotificationStore) {
      val scope = checkedScope(raw); val id = scope.getString("serverId")
      val old = NotificationStore.entry(context, id)?.let { JSONObject(it.toString()) }
      if (!NotificationStore.retireClient(context, scope, expected)) false else {
        if (old != null) sendRegistration(context, old.getString("distributor"), "UNREGISTER", old.getString("token"))
        true
      }
    } }
    Function("clearNotice") { id: String, noticeId: String ->
      require(noticeId.matches(Regex("[A-Za-z0-9-]{1,1000}")))
      NotificationStore.clearActions(context, id, "relay:$id:$noticeId"); NotificationStore.save(context)
    }
    Function("takeOpen") {
      val intent = pendingOpen ?: appContext.currentActivity?.intent
      pendingOpen = null
      if (intent?.action != "relay.notifications.OPEN" || intent.component?.packageName != context.packageName || intent.data != null) null else {
        val nonce = intent.getStringExtra(NotificationStore.GESTURE_EXTRA)
        val action = nonce?.let { NotificationStore.claim(context, it) }
        if (action == null || action.optString("choice") == "deny") null else mapOf("serverId" to action.getString("serverId"), "noticeId" to action.getString("noticeId"), "kind" to action.getString("kind"))
      }
    }
  }
  companion object {
    fun sendRegistration(context: android.content.Context, distributor: String, action: String, token: String, messageId: String? = null) {
      val intent = Intent("org.unifiedpush.android.distributor.$action").setPackage(distributor).putExtra("token", token)
      if (messageId != null) intent.putExtra("id", messageId)
      if (Build.VERSION.SDK_INT >= 34) context.sendBroadcast(intent, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
      else {
        intent.putExtra("pi", PendingIntent.getBroadcast(context, 0, Intent().setPackage("org.unifiedpush.dummy_app"), PendingIntent.FLAG_IMMUTABLE))
        context.sendBroadcast(intent)
      }
    }
  }
}
