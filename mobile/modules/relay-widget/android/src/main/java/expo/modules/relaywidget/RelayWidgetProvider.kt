package expo.modules.relaywidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import expo.modules.relaynotifications.PairedRead
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RelayWidgetProvider : AppWidgetProvider() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      // Explicit, from this app's own UnifiedPush receiver: the projection of that Servidor changed.
      PairedRead.WIDGET_REFRESH -> {
        val pending = goAsync()
        WidgetLive.refreshAsync(context.applicationContext, serverId = intent.getStringExtra("serverId") ?: "") { pending.finish() }
      }
      EXPIRE -> refresh(context)
      else -> super.onReceive(context, intent)
    }
  }
  override fun onDisabled(context: Context) {
    WidgetStore.clearReading(context)
    WidgetRefreshJob.cancel(context)
    context.getSystemService(AlarmManager::class.java).cancel(expiry(context))
  }
  // Also sent after boot and after an update: it reschedules the job, which is not persisted.
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.take(32).forEach { render(context, manager, it) }
    WidgetRefreshJob.schedule(context)
    val pending = goAsync()
    WidgetLive.refreshAsync(context.applicationContext, periodic = true) { pending.finish() }
  }
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) { render(context, manager, id) }
  companion object {
    private const val EXPIRE = "expo.modules.relaywidget.EXPIRE"
    private fun expiry(context: Context) = PendingIntent.getBroadcast(context, 0,
      Intent(context, RelayWidgetProvider::class.java).setAction(EXPIRE), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    fun refresh(context: Context) {
      val now = System.currentTimeMillis()
      // A clock moved back would make this reading current again later, past its real expiry: drop it.
      if (WidgetStore.reading(context)?.let { now < it.observedAt } == true) WidgetStore.clearReading(context)
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, RelayWidgetProvider::class.java)).take(32).forEach { render(context, manager, it) }
      // Render again when the reading expires, so it never stays on screen as current. Elapsed time, not the
      // wall clock, so moving the clock does not move the alarm; it does not wake the phone, and Android may
      // stretch the window (up to 10 min from API 31). The reading time stays visible.
      val reading = WidgetStore.reading(context)
      val alarms = context.getSystemService(AlarmManager::class.java)
      if (reading != null && WidgetReading.current(now, reading.observedAt, reading.expiresAt)) {
        alarms.setWindow(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + (reading.expiresAt - now), 60_000L, expiry(context))
      } else alarms.cancel(expiry(context))
    }
    private fun tap(context: Context, id: Int, scope: String?, target: String, requestCode: Int): PendingIntent {
      val intent = Intent().setComponent(ComponentName(context.packageName, "${context.packageName}.MainActivity"))
        .setAction("${context.packageName}.WIDGET_OPEN.$id")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra("relayWidgetId", id).putExtra("relayWidgetTarget", target)
      if (scope != null) intent.putExtra("relayWidgetScope", scope)
      return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    private fun render(context: Context, manager: AppWidgetManager, id: Int) {
      val target = WidgetStore.target(context)
      val reading = if (target != null) WidgetStore.reading(context) else null
      // Validated again at every render: an expired or future-dated reading is never shown as current.
      val current = reading != null && WidgetReading.current(System.currentTimeMillis(), reading.observedAt, reading.expiresAt)
      val dark = target?.appearance == "dark"
      val wide = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) >= 280
      val views = RemoteViews(context.packageName, if (wide) R.layout.relay_widget_wide else R.layout.relay_widget_compact)
      val ink = Color.parseColor(if (dark) "#ECEAE5" else "#1A1A19")
      val secondary = Color.parseColor(if (dark) "#B5B2AB" else "#4A4843")
      views.setInt(R.id.relay_widget_root, "setBackgroundResource", if (dark) R.drawable.relay_widget_frame_dark else R.drawable.relay_widget_frame)
      views.setInt(R.id.relay_widget_agents, "setBackgroundResource", if (dark) R.drawable.relay_widget_block_dark else R.drawable.relay_widget_block)
      // A reading of today shows only the time («LECTURA 22:22»); an older one adds the day.
      val date = reading?.let {
        val sameDay = SimpleDateFormat("yyyyMMdd", Locale.ROOT).let { day -> day.format(Date(it.observedAt)) == day.format(Date()) }
        SimpleDateFormat(if (sameDay) "HH:mm" else "dd/MM HH:mm", Locale("es", "MX")).format(Date(it.observedAt))
      }
      views.setTextViewText(R.id.relay_widget_title, if (reading == null) "ABRE RELAY" else if (current) "APROBACIONES" else "SIN LECTURA RECIENTE")
      views.setTextViewText(R.id.relay_widget_count, if (current) reading!!.count.toString() else "—")
      views.setTextViewText(R.id.relay_widget_date, if (date == null) "SIN DATOS VISIBLES" else if (current) "LECTURA $date" else "ÚLTIMO DATO $date")
      views.setViewVisibility(R.id.relay_widget_hint, if (current) View.GONE else View.VISIBLE)
      views.setTextViewText(R.id.relay_widget_hint, "Abre Relay para actualizar.")
      views.setTextViewText(R.id.relay_widget_action, if (current) "Revisar" else "Abrir Relay")
      views.setTextColor(R.id.relay_widget_count, Color.parseColor(if (current) "#F29A1A" else "#C9C6BE"))
      val rowIds = intArrayOf(R.id.relay_widget_row_0, R.id.relay_widget_row_1, R.id.relay_widget_row_2)
      val labelIds = intArrayOf(R.id.relay_widget_label_0, R.id.relay_widget_label_1, R.id.relay_widget_label_2)
      val ledIds = intArrayOf(R.id.relay_widget_led_0, R.id.relay_widget_led_1, R.id.relay_widget_led_2)
      val stateIds = intArrayOf(R.id.relay_widget_state_0, R.id.relay_widget_state_1, R.id.relay_widget_state_2)
      val serverIds = intArrayOf(R.id.relay_widget_server_0, R.id.relay_widget_server_1, R.id.relay_widget_server_2)
      val statuses = mapOf("busy" to "TRABAJANDO", "on" to "EN LÍNEA", "err" to "ERROR", "off" to "INACTIVO")
      val agents = reading?.agents.orEmpty()
      for (index in 0..2) {
        val agent = agents.getOrNull(index)
        views.setViewVisibility(rowIds[index], if (agent != null) View.VISIBLE else View.GONE)
        // A stale reading keeps the names with a neutral LED and no state, as in the design.
        val state = if (current) agent?.state ?: "off" else "stale"
        val color = when (state) { "busy" -> "#F29A1A"; "on" -> "#4CC774"; "err" -> "#E5533D"; else -> if (dark) "#3A3936" else "#B9B6AF" }
        views.setTextViewText(labelIds[index], agent?.label ?: "")
        views.setTextColor(labelIds[index], ink)
        views.setInt(ledIds[index], "setColorFilter", Color.parseColor(color))
        if (wide) {
          // One mono line, «ATLAS · TRABAJANDO»; a stale reading names only the Servidor.
          val server = (target?.label ?: "").uppercase(Locale("es", "MX"))
          views.setTextViewText(serverIds[index], if (current) "$server · ${statuses[state] ?: "—"}" else server); views.setTextColor(serverIds[index], secondary)
          views.setViewVisibility(stateIds[index], View.GONE)
        }
      }
      views.setViewVisibility(R.id.relay_widget_empty, if (agents.isEmpty()) View.VISIBLE else View.GONE)
      views.setTextViewText(R.id.relay_widget_empty, if (reading == null) "Sin datos del Servidor" else "Sin Agentes")
      views.setTextColor(R.id.relay_widget_empty, secondary)
      views.setContentDescription(R.id.relay_widget_root, when {
        date == null -> "Relay, sin datos visibles. Abrir Relay."
        current -> "Relay, lectura de $date. Abrir Relay."
        else -> "Relay, sin lectura reciente; último dato $date. Abrir Relay."
      })
      val scope = target?.scope
      views.setOnClickPendingIntent(R.id.relay_widget_root, tap(context, id, scope, if (!wide && current) "approvals" else "agents", id * 2))
      // Different PendingIntent identities prevent one target overwriting the other.
      views.setOnClickPendingIntent(R.id.relay_widget_action, tap(context, id, scope, if (current) "approvals" else "agents", id * 2 + 1))
      manager.updateAppWidget(id, views)
    }
  }
}
