package expo.modules.relaywidget

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import expo.modules.relaynotifications.PairedRead
import org.json.JSONObject

/** Reads GET /v1/widget for the followed Servidor, without the app's UI: on a push signal, the job or a new target. */
internal object WidgetLive {
  fun installed(context: Context) =
    AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, RelayWidgetProvider::class.java)).isNotEmpty()

  private val flight = RefreshFlight()

  /** Runs off the main thread, only inside the flight: one read at a time. */
  private fun refresh(context: Context, periodic: Boolean) {
    try {
      if (!installed(context)) return
      val target = WidgetStore.target(context) ?: return
      val started = System.currentTimeMillis()
      if (periodic && WidgetStore.reading(context)?.let { !WidgetReading.periodicDue(started, it.observedAt) } == true) return
      // A network failure keeps the dated reading; it turns into «sin datos recientes» on its own.
      val response = try { PairedRead.widget(context, target.serverId, target.deviceId, target.url) } catch (_: Exception) { return }
      if (response == null) { WidgetStore.retire(context, target); return }
      when (WidgetReading.outcome(response.status, response.body.optJSONObject("error")?.optString("code"))) {
        WidgetReading.Outcome.STORE -> reading(response.body, started)?.let { WidgetStore.store(context, target, it) }
        WidgetReading.Outcome.NEUTRAL -> WidgetStore.retire(context, target)
        WidgetReading.Outcome.FORGET -> WidgetStore.forget(context, target)
        WidgetReading.Outcome.KEEP -> Unit
      }
    } catch (_: Exception) { /* Untrusted data and private failures never enter logs. */ }
    finally { RelayWidgetProvider.refresh(context) }
  }

  /**
   * `serverId` limits a push signal to its own Servidor, checked before it can take the pending place.
   * A signal that folds into a pending read calls `done` at once.
   */
  fun refreshAsync(context: Context, periodic: Boolean = false, serverId: String? = null, done: () -> Unit = {}) {
    Thread {
      try {
        if (serverId == null || serverId == WidgetStore.target(context)?.serverId) flight.run(periodic) { refresh(context, it) }
      } catch (_: Exception) { } finally { done() }
    }.apply { isDaemon = true }.start()
  }

  /** Exactly protocol/widget.ts WidgetProjection; anything else is not a reading. */
  private fun reading(body: JSONObject, started: Long): WidgetStore.Reading? {
    if (body.keys().asSequence().toSet() != setOf("schema", "observedAt", "expiresAt", "count", "agents") || body.opt("schema") != 1) return null
    val expiresAt = WidgetReading.phoneExpiry(body.getLong("observedAt"), body.getLong("expiresAt"), started)
    val count = body.getInt("count")
    val agents = WidgetStore.parseAgents(body.getJSONArray("agents"))
    return if (expiresAt == -1L || count !in 0..999 || agents == null) null else WidgetStore.Reading(started, expiresAt, count, agents)
  }
}

/**
 * Fallback renewal when no push arrives: Android's periodic minimum (15 min), any network, deferred by
 * Doze like any job. It skips the read when a push renewed the reading recently.
 */
class WidgetRefreshJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    WidgetLive.refreshAsync(applicationContext, periodic = true) { jobFinished(params, false) }
    return true
  }
  override fun onStopJob(params: JobParameters) = false
  companion object {
    private const val ID = 0x52574c
    fun schedule(context: Context) {
      val scheduler = context.getSystemService(JobScheduler::class.java)
      if (scheduler.getPendingJob(ID) != null) return
      scheduler.schedule(JobInfo.Builder(ID, ComponentName(context, WidgetRefreshJob::class.java))
        .setPeriodic(15 * 60_000L).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build())
    }
    fun cancel(context: Context) { context.getSystemService(JobScheduler::class.java).cancel(ID) }
  }
}
