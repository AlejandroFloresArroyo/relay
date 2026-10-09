package expo.modules.relaynotifications

/** Bounded one-way cache identity; the key never becomes a storage name or UI value. */
internal fun notificationKeyIdentity(key: String): String {
  require(key.length in 1..4096)
  return java.security.MessageDigest.getInstance("SHA-256")
    .digest(("relay.notifications.cache.v2\u0000" + key).toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }
}
