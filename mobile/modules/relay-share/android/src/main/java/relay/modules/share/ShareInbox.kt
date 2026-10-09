package relay.modules.share

import android.os.SystemClock
import java.io.File
import java.util.UUID

// Opaque capabilities stay in-process. No names, source URIs, payload logs or restart replay.
internal object ShareInbox {
  private data class Entry(val token: String, val created: Long, val data: Map<String, Any>, val directory: File?)
  private var overflow: Pair<String, Long>? = null
  private var initialized = false
  @Synchronized fun initialize(cache: File) {
    if (initialized) return
    initialized = true
    // A process restart restores no authority. Remove abandoned native copies only.
    File(cache, "relay-share").listFiles()?.forEach { file ->
      if (file.name.matches(Regex("[a-f0-9-]{36}"))) file.deleteRecursively()
    }
  }
  private val entries = mutableListOf<Entry>()
  var changed: (() -> Unit)? = null
  @Synchronized private fun prune() {
    if (overflow?.let { SystemClock.elapsedRealtime() - it.second >= 900000 } == true) overflow = null
    val expired = entries.filter { SystemClock.elapsedRealtime() - it.created >= 900000 }
    expired.forEach { it.directory?.deleteRecursively() }; entries.removeAll(expired.toSet())
  }
  @Synchronized fun add(data: Map<String, Any>, directory: File?) {
    prune()
    if (entries.size >= 3) {
      directory?.deleteRecursively()
      if (overflow == null) overflow = Pair(UUID.randomUUID().toString(), SystemClock.elapsedRealtime())
      changed?.invoke(); return
    }
    entries.add(Entry(UUID.randomUUID().toString(), SystemClock.elapsedRealtime(), data, directory))
    changed?.invoke()
  }
  @Synchronized fun pending(): List<String> { prune(); return entries.map { it.token } + listOfNotNull(overflow?.first) }
  @Synchronized fun read(token: String): Map<String, Any>? { prune(); if (token == overflow?.first) return mapOf("kind" to "rejected", "reason" to "queue_full"); return entries.find { it.token == token }?.data }
  @Synchronized fun discard(token: String) {
    if (token == overflow?.first) { overflow = null; changed?.invoke(); return }
    val entry = entries.find { it.token == token } ?: return
    entries.remove(entry); entry.directory?.deleteRecursively(); changed?.invoke()
  }
}
