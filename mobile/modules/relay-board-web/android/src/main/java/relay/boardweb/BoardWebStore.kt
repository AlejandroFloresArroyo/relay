package relay.boardweb

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

internal data class BoardWebAsset(val name: String, val mime: String, val size: Int, val hash: String)
internal class BoardWebSnapshot(val id: String, val generation: String, val assets: List<BoardWebAsset>) {
  val bytes = mutableMapOf<String, ByteArray>()
  var sealed = false
  @Volatile var retired = false
  val size = assets.sumOf { it.size }
}
internal object BoardWebStore {
  private val generations = mutableSetOf<String>()
  private val snapshots = mutableMapOf<String, BoardWebSnapshot>()
  private var reserved = 0
  @Volatile private var foreground = true
  fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun requireLive(generation: String) { check(foreground && generations.contains(generation)) { "board_web_retired" } }
  @Synchronized fun begin(): String {
    check(foreground && generations.size < 32) { "board_web_busy" }
    return UUID.randomUUID().toString().also { generations.add(it) }
  }
  @Synchronized fun create(generation: String, revision: String, canonical: String): String {
    requireLive(generation)
    check(canonical.toByteArray(Charsets.UTF_8).size <= 16384 && revision.matches(Regex("[a-f0-9]{64}")) && sha(canonical.toByteArray(Charsets.UTF_8)) == revision) { "board_web_invalid" }
    val json = JSONObject(canonical)
    check(json.keys().asSequence().toSet() == setOf("schemaVersion", "entry", "files") && json.get("schemaVersion") == 1 && json.get("entry") == "index.html") { "board_web_invalid" }
    val rows = json.getJSONArray("files"); check(rows.length() in 1..32) { "board_web_invalid" }
    val mime = mapOf("html" to "text/html", "js" to "application/javascript", "css" to "text/css", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "webp" to "image/webp")
    val assets = (0 until rows.length()).map { i ->
      val row = rows.getJSONObject(i)
      check(row.keys().asSequence().toSet() == setOf("name", "mime", "bytes", "sha256")) { "board_web_invalid" }
      val name = row.get("name") as? String ?: error("board_web_invalid")
      val type = row.get("mime") as? String ?: error("board_web_invalid")
      val count = row.get("bytes"); check(count is Int && count in 1..262144) { "board_web_invalid" }
      val hash = row.get("sha256") as? String ?: error("board_web_invalid")
      check(name.length <= 64 && name.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]*\\.(html|js|css|png|jpg|jpeg|webp)")) && mime[name.substringAfterLast('.')] == type && hash.matches(Regex("[a-f0-9]{64}"))) { "board_web_invalid" }
      BoardWebAsset(name, type, count as Int, hash)
    }
    check(assets.map { it.name }.distinct().size == assets.size && assets.any { it.name == "index.html" } && assets == assets.sortedBy { it.name } && assets.sumOf { it.size } <= 1048576) { "board_web_invalid" }
    val serialized = "{\"schemaVersion\":1,\"entry\":\"index.html\",\"files\":[" + assets.joinToString(",") {
      "{\"name\":\"${it.name}\",\"mime\":\"${it.mime}\",\"bytes\":${it.size},\"sha256\":\"${it.hash}\"}"
    } + "]}"
    check(serialized == canonical && reserved + assets.sumOf { it.size } <= 8388608 && snapshots.size < 32) { "board_web_invalid" }
    val snapshot = BoardWebSnapshot(UUID.randomUUID().toString(), generation, assets)
    snapshots[snapshot.id] = snapshot; reserved += snapshot.size
    return snapshot.id
  }
  @Synchronized fun put(generation: String, id: String, name: String, encoded: String) {
    requireLive(generation)
    val snapshot = snapshots[id] ?: error("board_web_retired")
    check(snapshot.generation == generation && !snapshot.retired && !snapshot.sealed && !snapshot.bytes.containsKey(name)) { "board_web_retired" }
    val file = snapshot.assets.find { it.name == name } ?: error("board_web_invalid")
    check(encoded.length <= 349528 && encoded.length == ((file.size + 2) / 3) * 4 && encoded.matches(Regex("[A-Za-z0-9+/]*={0,2}"))) { "board_web_invalid" }
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    check(bytes.size == file.size && sha(bytes) == file.hash) { "board_web_invalid" }
    requireLive(generation); check(snapshots[id] === snapshot) { "board_web_retired" }
    snapshot.bytes[name] = bytes
  }
  @Synchronized fun seal(generation: String, id: String): String {
    requireLive(generation); val snapshot = snapshots[id] ?: error("board_web_retired")
    check(snapshot.generation == generation && !snapshot.retired && snapshot.bytes.size == snapshot.assets.size) { "board_web_invalid" }
    snapshot.sealed = true; return id
  }
  @Synchronized fun get(id: String): BoardWebSnapshot? = snapshots[id]?.takeIf { foreground && it.sealed && !it.retired && generations.contains(it.generation) }
  @Synchronized fun remove(id: String) {
    snapshots.remove(id)?.let { it.retired = true; reserved -= it.size; it.bytes.clear() }
  }
  @Synchronized fun retire(generation: String) {
    generations.remove(generation)
    snapshots.values.filter { it.generation == generation }.map { it.id }.forEach { remove(it) }
    BoardWebViews.retire(generation)
  }
  @Synchronized fun background() { foreground = false; generations.toList().forEach { retire(it) } }
  @Synchronized fun resume() { foreground = true }
}
