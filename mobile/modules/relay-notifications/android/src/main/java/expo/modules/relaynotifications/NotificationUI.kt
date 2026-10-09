package expo.modules.relaynotifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

internal object NotificationUI {
  fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    for ((kind, label) in listOf("approval" to "Aprobaciones", "task" to "Tareas", "error" to "Errores", "server" to "Servidores"))
      manager.createNotificationChannel(NotificationChannel("relay.$kind", label, if (kind == "approval") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT))
  }
  private fun builder(context: Context, kind: String) = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, "relay.$kind") else Notification.Builder(context)
  private fun intent(context: Context, entry: JSONObject, envelope: JSONObject, choice: String, tag: String): PendingIntent {
    val nonce = NotificationStore.action(context, entry, envelope, choice, tag)
    val intent = if (choice == "deny") Intent(context, NotificationDecisionReceiver::class.java).setAction("relay.notifications.DENY")
      else requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName)).setAction("relay.notifications.OPEN")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    intent.putExtra(NotificationStore.GESTURE_EXTRA, nonce)
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT
    return if (choice == "deny") PendingIntent.getBroadcast(context, nonce.hashCode(), intent, flags) else PendingIntent.getActivity(context, nonce.hashCode(), intent, flags)
  }
  fun show(context: Context, entry: JSONObject, envelope: JSONObject, reviewOnly: Boolean = false, detail: String = "Abre Relay para revisar el comando.") {
    val kind = envelope.getString("kind")
    require(kind in listOf("approval", "task", "error", "server"))
    val title = when (kind) { "approval" -> "Aprobación pendiente"; "task" -> "Actividad de una Tarea"; "error" -> "Error del Agente"; else -> "Estado del Servidor" }
    channels(context)
    val tag = "relay:" + entry.getString("serverId") + ":" + envelope.getString("noticeId")
    NotificationStore.clearActions(context, entry.getString("serverId"), tag)
    val review = intent(context, entry, envelope, "review", tag)
    val generic = builder(context, kind).setSmallIcon(R.drawable.ic_relay_notification)
      .setContentTitle("Hay un aviso de Relay").setContentText("Desbloquea Relay para revisarlo.")
      .setContentIntent(review).addAction(Notification.Action.Builder(null, "Revisar", review).build()).setAutoCancel(true).build()
    val builder = builder(context, kind).setSmallIcon(R.drawable.ic_relay_notification)
      .setContentTitle("Relay · $title").setContentText(if (kind == "approval") detail else "Abre Relay para consultar la actividad.").setContentIntent(review)
      .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(generic).setAutoCancel(true)
    if (kind == "approval" && !reviewOnly && NotificationStore.unlocked(context)) {
      for ((choice, label) in listOf("approve" to "Aprobar", "deny" to "Rechazar")) {
        val action = Notification.Action.Builder(null, label, intent(context, entry, envelope, choice, tag))
        if (Build.VERSION.SDK_INT >= 31) action.setAuthenticationRequired(true)
        builder.addAction(action.build())
      }
    }
    builder.addAction(Notification.Action.Builder(null, "Revisar", review).build())
    val serverNow = NotificationStore.serverTime(context, entry)
    if (serverNow != null) {
      val deadline = if (envelope.isNull("expiresAt")) entry.optLong("expiresAt", serverNow) else minOf(entry.optLong("expiresAt", serverNow), envelope.getLong("expiresAt"))
      if (deadline <= serverNow) { NotificationStore.clearActions(context, entry.getString("serverId"), tag); NotificationStore.save(context); return }
      if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(deadline - serverNow)
    }
    if (!NotificationStore.current(context, entry)) return
    context.getSystemService(NotificationManager::class.java).notify(tag, 1, builder.build())
  }
}
