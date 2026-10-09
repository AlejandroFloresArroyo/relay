package expo.modules.relaywidget

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.appwidget.AppWidgetManager
import android.os.SystemClock

internal object WidgetOpen {
  private var pending: Map<String, Any?>? = null
  private var receivedAt = 0L
  @Synchronized fun capture(context: Context, intent: Intent?): Boolean { return try {
    if (intent == null || intent.component != ComponentName(context.packageName, "${context.packageName}.MainActivity")) return false
    val id = intent.getIntExtra("relayWidgetId", -1)
    val installed = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, RelayWidgetProvider::class.java))
    if (id !in installed || intent.action != "${context.packageName}.WIDGET_OPEN.$id" || intent.data != null) return false
    val target = intent.getStringExtra("relayWidgetTarget")
    val scope = intent.getStringExtra("relayWidgetScope")
    val allowed = setOf("relayWidgetId", "relayWidgetTarget", "relayWidgetScope")
    if (intent.extras?.keySet()?.any { it !in allowed } == true || target !in listOf("agents", "approvals") ||
      scope != null && !Regex("^w-[0-9a-f]{16}$").matches(scope) || scope == null && target != "agents") return false
    pending = mapOf("target" to target, "scope" to scope)
    receivedAt = SystemClock.elapsedRealtime()
    // Prevent re-reading the launch request after module reload or rotation.
    intent.action = null
    true
  } catch (_: Exception) { false }
  }
  @Synchronized fun take(): Map<String, Any?>? {
    val result = pending
    pending = null
    return if (SystemClock.elapsedRealtime() - receivedAt < 120000) result else null
  }
}
