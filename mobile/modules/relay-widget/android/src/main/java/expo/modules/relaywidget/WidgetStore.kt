package expo.modules.relaywidget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * App-private, excluded from backup, at most 4 KiB per file. The target names the Servidor the widget
 * follows (never its key); the reading is the validated GET /v1/widget projection in phone-clock time.
 */
internal object WidgetStore {
  data class Target(val serverId: String, val deviceId: String, val url: String, val scope: String, val label: String, val appearance: String) {
    val identity get() = listOf(serverId, deviceId, url, scope)
  }
  data class Agent(val label: String, val state: String)
  data class Reading(val observedAt: Long, val expiresAt: Long, val count: Int, val agents: List<Agent>)

  private const val TARGET = "relay-widget-target.json"
  private const val READING = "relay-widget.json"
  private val STATES = setOf("on", "busy", "err", "off")
  private fun file(context: Context, name: String) = AtomicFile(File(context.noBackupFilesDir, name))

  fun label(value: String, fallback: String): String =
    if (Regex("^[\\p{L}\\p{N} _. -]{1,24}$").matches(value) && !Regex("rly1_|sk-|bearer|token|secret|api.?key|password", RegexOption.IGNORE_CASE).containsMatchIn(value)) value else fallback
  private fun keys(value: JSONObject) = value.keys().asSequence().toSet()

  fun parseTarget(value: JSONObject): Target? = try {
    val target = Target(value.getString("serverId"), value.getString("deviceId"), value.getString("url"), value.getString("scope"),
      label(value.getString("label"), "Servidor"), value.getString("appearance"))
    if (keys(value) != setOf("serverId", "deviceId", "url", "scope", "label", "appearance") || target.serverId.length !in 1..255
      || target.deviceId.length !in 1..255 || target.url.length !in 1..1000 || !Regex("^w-[0-9a-f]{16}$").matches(target.scope)
      || target.appearance !in listOf("light", "dark")) null else target
  } catch (_: Exception) { null }

  /** Agents of a stored reading or of a Puente projection: at most three, allowed labels, enumerated states. */
  fun parseAgents(value: JSONArray): List<Agent>? {
    if (value.length() > 3) return null
    return (0 until value.length()).map { index ->
      val agent = value.getJSONObject(index)
      if (keys(agent) != setOf("label", "state") || agent.getString("state") !in STATES) return null
      Agent(label(agent.getString("label"), "Agente"), agent.getString("state"))
    }
  }

  private fun parseReading(value: JSONObject): Reading? = try {
    val reading = Reading(value.getLong("observedAt"), value.getLong("expiresAt"), value.getInt("count"), parseAgents(value.getJSONArray("agents"))!!)
    if (keys(value) != setOf("observedAt", "expiresAt", "count", "agents") || reading.count !in 0..999
      || reading.expiresAt - reading.observedAt !in 1..WidgetReading.TTL_MS) null else reading
  } catch (_: Exception) { null }

  private fun load(context: Context, name: String): JSONObject? = try {
    file(context, name).openRead().use { stream ->
      val bytes = ByteArray(4097)
      var size = 0
      while (size < bytes.size) { val count = stream.read(bytes, size, bytes.size - size); if (count < 0) break; size += count }
      if (size > 4096) null else JSONObject(String(bytes, 0, size, Charsets.UTF_8))
    }
  } catch (_: Exception) { null }

  private fun write(context: Context, name: String, value: JSONObject) {
    val output = file(context, name)
    val stream = output.startWrite()
    try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); output.finishWrite(stream) }
    catch (error: Exception) { output.failWrite(stream); throw error }
  }

  private fun delete(context: Context, name: String) { try { file(context, name).delete() } catch (_: Exception) { } }

  @Synchronized fun target(context: Context): Target? = load(context, TARGET)?.let(::parseTarget)
  @Synchronized fun reading(context: Context): Reading? = load(context, READING)?.let(::parseReading)

  /** Another Servidor, pairing or none drops the old reading at once. True when a read is due. */
  @Synchronized fun setTarget(context: Context, next: Target?): Boolean {
    val previous = target(context)
    val same = previous != null && next != null && previous.identity == next.identity
    if (!same) delete(context, READING)
    if (next == null) delete(context, TARGET)
    else write(context, TARGET, JSONObject().put("serverId", next.serverId).put("deviceId", next.deviceId).put("url", next.url)
      .put("scope", next.scope).put("label", next.label).put("appearance", next.appearance))
    return next != null && (!same || reading(context)?.let { WidgetReading.current(System.currentTimeMillis(), it.observedAt, it.expiresAt) } != true)
  }

  /** A reading started for one Servidor is never stored once the widget follows another. */
  @Synchronized fun store(context: Context, expected: Target, reading: Reading): Boolean {
    if (target(context)?.identity != expected.identity) return false
    write(context, READING, JSONObject().put("observedAt", reading.observedAt).put("expiresAt", reading.expiresAt).put("count", reading.count)
      .put("agents", JSONArray(reading.agents.map { JSONObject().put("label", it.label).put("state", it.state) })))
    return true
  }

  /** Neutral shortcut: no reading, same Servidor. */
  @Synchronized fun retire(context: Context, expected: Target) { if (target(context)?.identity == expected.identity) delete(context, READING) }

  /** The Puente refused this device: nothing about that Servidor stays on the home screen. */
  @Synchronized fun forget(context: Context, expected: Target) {
    if (target(context)?.identity != expected.identity) return
    delete(context, READING); delete(context, TARGET)
  }

  @Synchronized fun clearReading(context: Context) { delete(context, READING) }
}
