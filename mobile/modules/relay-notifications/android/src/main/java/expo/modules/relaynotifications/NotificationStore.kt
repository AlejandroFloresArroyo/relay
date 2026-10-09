package expo.modules.relaynotifications

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.util.UUID

/** One encrypted private snapshot; all generation changes and replacements are synchronous. */
internal object NotificationStore {
  private var state: JSONObject? = null
  private var failed = false
  const val GESTURE_EXTRA = "relay.notifications.GESTURE"
  private const val ALIAS = "relay.notifications.private.v1"
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (!store.containsAlias(ALIAS)) KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      generateKey()
    }
    return store.getKey(ALIAS, null) as SecretKey
  }
  @Synchronized fun read(context: Context): JSONObject {
    check(!failed) { "Registro de Avisos no disponible." }
    state?.let { return it }
    try {
      val prefs = context.getSharedPreferences(ALIAS, Context.MODE_PRIVATE)
      val raw = prefs.getString("snapshot", null)
      val empty = { JSONObject().put("entries", JSONObject()).put("generations", JSONObject()).put("actions", JSONObject()) }
      state = if (raw == null) empty() else try {
        val parts = raw.split(':'); check(parts.size == 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        JSONObject(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
      } catch (error: GeneralSecurityException) {
        // Only a tag mismatch means a new Keystore key (restore or reinstall). Other errors keep the snapshot.
        if (!SnapshotDecryption.discard(error)) throw error
        check(prefs.edit().remove("snapshot").commit()); empty()
      }
      if (!state!!.has("pairings")) state!!.put("pairings", JSONObject())
      if (!state!!.has("pairingGenerations")) state!!.put("pairingGenerations", JSONObject())
      return state!!
    } catch (_: Exception) { failed = true; error("Registro de Avisos no disponible.") }
  }
  @Synchronized fun save(context: Context) {
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
      val encrypted = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(read(context).toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
      check(context.getSharedPreferences(ALIAS, Context.MODE_PRIVATE).edit().putString("snapshot", encrypted).commit())
    } catch (_: Exception) { failed = true; error("No se pudo conservar la inscripción de Avisos.") }
  }
  private fun samePairing(a: JSONObject, b: JSONObject) = listOf("serverId", "url", "deviceId", "key").all { a.optString(it) == b.optString(it) }
  @Synchronized fun reconcile(context: Context, allowed: org.json.JSONArray) {
    val data = read(context); val pairs = data.getJSONObject("pairings"); val epochs = data.getJSONObject("pairingGenerations")
    var changed = false
    val incoming = (0 until allowed.length()).map { allowed.getJSONObject(it) }.filter { !it.optBoolean("revoked") && it.optString("deviceId").isNotEmpty() }
    for (id in pairs.keys().asSequence().toList()) {
      val next = incoming.firstOrNull { it.optString("serverId") == id }
      if (next == null || !samePairing(pairs.getJSONObject(id), next)) {
        purge(context, id); pairs.remove(id); epochs.put(id, epochs.optLong(id, 0) + 1); changed = true
      }
    }
    for (id in data.getJSONObject("entries").keys().asSequence().toList()) {
      val entry = data.getJSONObject("entries").getJSONObject(id)
      if (incoming.none { it.optString("serverId") == id && samePairing(entry, it) }) purge(context, id)
    }
    for (input in incoming) {
      val id = input.getString("serverId")
      if (!pairs.has(id)) {
        PrivateBridge.validateOrigin(input.getString("url"))
        val generation = epochs.optLong(id, 0) + 1; epochs.put(id, generation)
        pairs.put(id, JSONObject(input.toString()).put("pairingGeneration", generation)); changed = true
      }
    }
    if (changed) save(context)
  }
  @Synchronized fun capturePairing(context: Context, input: JSONObject): JSONObject {
    val paired = requireNotNull(read(context).getJSONObject("pairings").optJSONObject(input.getString("serverId")))
    check(samePairing(paired, input)); return JSONObject(paired.toString())
  }
  @Synchronized fun pairingCurrent(context: Context, input: JSONObject): Boolean {
    val paired = read(context).getJSONObject("pairings").optJSONObject(input.getString("serverId")) ?: return false
    return samePairing(paired, input) && paired.optLong("pairingGeneration") == input.optLong("pairingGeneration")
  }
  @Synchronized fun captureRevocation(context: Context, scope: JSONObject): JSONObject {
    val paired = capturePairing(context, scope)
    if (scope.has("pairingGeneration")) check(pairingCurrent(context, scope))
    if (scope.has("revocationGeneration")) check(generation(context, scope.getString("serverId")) == scope.getLong("revocationGeneration"))
    if (scope.has("generation")) check(current(context, scope))
    return paired.put("revocationGeneration", read(context).getJSONObject("generations").optLong(scope.getString("serverId"), 0))
  }
  @Synchronized fun purgeCaptured(context: Context, captured: JSONObject): Boolean {
    val id = captured.getString("serverId")
    if (!pairingCurrent(context, captured) || read(context).getJSONObject("generations").optLong(id, 0) != captured.getLong("revocationGeneration")) return false
    // Compare and delete under the same monitor: an older refusal cannot retire a new enrollment.
    purge(context, id)
    return true
  }
  @Synchronized fun entry(context: Context, id: String): JSONObject? = read(context).getJSONObject("entries").optJSONObject(id)
  @Synchronized fun purge(context: Context, id: String) {
    val data = read(context); val generations = data.getJSONObject("generations")
    generations.put(id, generations.optLong(id, 0) + 1)
    data.getJSONObject("entries").remove(id)
    clearActions(context, id); save(context)
  }
  @Synchronized fun clearActions(context: Context, id: String, tag: String? = null) {
    val actions = read(context).getJSONObject("actions")
    if (tag != null) context.getSystemService(NotificationManager::class.java).cancel(tag, 1)
    for (nonce in actions.keys().asSequence().toList()) if (actions.getJSONObject(nonce).optString("serverId") == id && (tag == null || actions.getJSONObject(nonce).optString("tag") == tag)) {
      val action = actions.getJSONObject(nonce)
      context.getSystemService(NotificationManager::class.java).cancel(action.optString("tag"), 1)
      actions.remove(nonce)
    }
  }
  @Synchronized fun begin(context: Context, input: JSONObject, distributor: String, uid: Int): JSONObject {
    capturePairing(context, input)
    val id = input.getString("serverId"); purge(context, id)
    val generation = read(context).getJSONObject("generations").getLong(id)
    val entry = JSONObject(input.toString()).put("generation", generation).put("distributor", distributor).put("distributorUid", uid)
      .put("token", UUID.randomUUID().toString()).put("endpoint", JSONObject.NULL).put("registrationId", JSONObject.NULL).put("state", "waiting")
    read(context).getJSONObject("entries").put(id, entry); save(context)
    return entry
  }
  @Synchronized fun generation(context: Context, id: String): Long = read(context).getJSONObject("generations").optLong(id, 0)
  @Synchronized fun retireClient(context: Context, scope: JSONObject, expected: Long): Boolean {
    require(expected >= 0)
    val id = scope.getString("serverId")
    val paired = read(context).getJSONObject("pairings").optJSONObject(id) ?: return false
    if (!samePairing(paired, scope)) return false
    val generation = generation(context, id)
    if (generation == expected) { purge(context, id); return true }
    // A confirmed refusal already incremented this epoch; never touch a later enrollment.
    return generation == expected + 1 && entry(context, id) == null
  }
  @Synchronized fun status(context: Context, id: String): Map<String, Any?> {
    val entry = entry(context, id)
    return mapOf("generation" to generation(context, id), "state" to (entry?.optString("state") ?: "missing"),
      "endpoint" to entry?.optString("endpoint")?.takeUnless { it == "null" || it.isEmpty() }, "distributor" to entry?.optString("distributor"))
  }
  @Synchronized fun byToken(context: Context, token: String): JSONObject? = read(context).getJSONObject("entries").let { entries ->
    entries.keys().asSequence().map { entries.getJSONObject(it) }.firstOrNull { it.optString("token") == token }
  }
  @Synchronized fun current(context: Context, captured: JSONObject): Boolean {
    val entry = entry(context, captured.getString("serverId")) ?: return false
    return entry.optLong("generation") == captured.optLong("generation") && entry.optString("registrationId") == captured.optString("registrationId")
      && entry.optString("key") == captured.optString("key")
  }
  fun serverTime(context: Context, entry: JSONObject): Long? {
    val elapsed = android.os.SystemClock.elapsedRealtime() - entry.optLong("checkedElapsed", -1)
    val boot = android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.BOOT_COUNT, -1)
    return if (elapsed < 0 || entry.optInt("bootCount", -2) != boot || entry.optLong("serverNow", -1) < 0) null else entry.getLong("serverNow") + elapsed
  }
  fun unlocked(context: Context): Boolean = context.getSystemService(KeyguardManager::class.java).let { it.isDeviceSecure && !it.isDeviceLocked && !it.isKeyguardLocked }
  @Synchronized fun action(context: Context, entry: JSONObject, envelope: JSONObject, choice: String, tag: String): String {
    check(current(context, entry))
    val nonce = UUID.randomUUID().toString()
    read(context).getJSONObject("actions").put(nonce, JSONObject().put("serverId", entry.getString("serverId"))
      .put("generation", entry.getLong("generation")).put("registrationId", envelope.getString("registrationId"))
      .put("noticeId", envelope.getString("noticeId")).put("kind", envelope.getString("kind")).put("choice", choice).put("tag", tag))
    save(context); return nonce
  }
  @Synchronized fun claim(context: Context, nonce: String, expected: String? = null): JSONObject? {
    val actions = read(context).getJSONObject("actions"); val action = actions.optJSONObject(nonce) ?: return null
    if (expected != null && action.optString("choice") != expected) return null
    val entry = entry(context, action.optString("serverId")) ?: return null
    if (entry.optLong("generation") != action.optLong("generation") || entry.optString("registrationId") != action.optString("registrationId")) return null
    actions.remove(nonce); save(context)
    return JSONObject(action.toString())
  }
}
