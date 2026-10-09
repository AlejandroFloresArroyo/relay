package expo.modules.relayvpn

import android.app.Activity
import android.app.Instrumentation
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcel

// The platform runner never obtains a real ConnectivityManager or queries a real network.
class RelayVpnLifecycleInstrumentation : Instrumentation() {
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

  override fun onStart() {
    val packageName = targetContext.packageName
    check(packageName.endsWith(".test") || packageName.endsWith(".dev")) {
      "VPN checks require an isolated test or development package."
    }
    check(android.os.Build.VERSION.SDK_INT >= 30) { "VPN platform checks require Android 11 or newer." }
    checkObservation()
    finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "Relay VPN lifecycle checks passed.\n") })
  }

  private fun checkObservation() {
    val network = syntheticNetwork(41)
    val otherNetwork = syntheticNetwork(42)
    check(network != otherNetwork) { "Synthetic Android network identities must be distinct." }
    val vpn = NetworkCapabilities()
    val absent = NetworkCapabilities()
    val port = SyntheticNetwork(network, vpn, absent)
    val emitted = mutableListOf<Map<String, Any>>()
    var activityPresent = true
    val main = Handler(Looper.getMainLooper())
    val observer = VpnObservation(
      connect = { port }, activityPresent = { activityPresent },
      post = { action -> main.post { action() } }, emit = { emitted.add(it) },
    )
    var first: ConnectivityManager.NetworkCallback? = null
    try {
      runOnMainSync {
        val snapshot = observer.observe(11)
        check(snapshot["vpn"] == "available" && snapshot["generation"] == 11 && snapshot["sequence"] == 0L) {
          "Snapshot must use synthetic Android capabilities and the requested generation."
        }
        first = port.registered.single()
        first!!.onAvailable(network)
        first!!.onCapabilitiesChanged(network, vpn)
        first!!.onBlockedStatusChanged(network, false)
      }
      waitForIdleSync()
      runOnMainSync {
        check(emitted.map { it["sequence"] } == listOf(1L, 2L, 3L)) { "Callbacks must preserve monotonic sequence." }
        check(emitted.last()["vpn"] == "available") { "Ordered callbacks must classify VPN capabilities." }
        val reads = port.reads
        emitted.clear()
        first!!.onCapabilitiesChanged(otherNetwork, absent)
        check(port.reads == reads) { "Callbacks must not query the Android network synchronously." }
      }
      waitForIdleSync()
      runOnMainSync {
        check(emitted.isEmpty()) { "Foreign-network capabilities must not change the observation." }
        first!!.onBlockedStatusChanged(network, true)
      }
      waitForIdleSync()
      runOnMainSync {
        check(observer.snapshot(11)["reason"] == "blocked") { "Blocked network must remain unknown." }
        // Blur retires through this exact stop operation in useVpnState, not a new native blur listener.
        observer.stop(11)
        check(port.registered.isEmpty()) { "Blur stop must unregister its listener." }
        check(observer.snapshot(11)["reason"] == "inactive") { "Stopped generation must remain inactive." }
        observer.observe(12)
        check(port.registered.size == 1) { "Refocus must register exactly one fresh listener." }
        emitted.clear()
        first!!.onAvailable(network)
        first!!.onCapabilitiesChanged(network, vpn)
        first!!.onBlockedStatusChanged(network, false)
      }
      waitForIdleSync()
      runOnMainSync {
        check(emitted.isEmpty()) { "Retired-generation callbacks must not publish after refocus." }
        observer.stop(11)
        check(port.registered.size == 1) { "A stale stop must not remove the current listener." }
        val reads = port.reads
        check(observer.snapshot(11)["reason"] == "inactive") { "A foreign-generation snapshot must fail closed." }
        check(port.reads == reads) { "Foreign snapshot must fail before reading Android capabilities." }
        val previous = port.registered.single()
        observer.observe(12)
        emitted.clear()
        previous.onAvailable(network)
        previous.onCapabilitiesChanged(network, absent)
        previous.onBlockedStatusChanged(network, false)
      }
      waitForIdleSync()
      runOnMainSync {
        check(emitted.isEmpty()) { "A replaced callback must stay retired even if its generation is reused." }
        val current = port.registered.single()
        current.onAvailable(network)
        observer.stop(12)
        emitted.clear()
      }
      waitForIdleSync()
      runOnMainSync {
        check(emitted.isEmpty()) { "A queued callback must be rechecked after stop." }
        check(port.registered.isEmpty()) { "Queued-callback retirement must release the listener." }
        observer.observe(13)
        observer.setForeground(false)
        check(port.registered.isEmpty()) { "Background must release all listeners." }
        check(observer.observe(14)["reason"] == "inactive" && port.registered.isEmpty()) {
          "Background observe must not register a listener."
        }
        observer.setForeground(true)
        activityPresent = false
        check(observer.observe(15)["reason"] == "inactive" && port.registered.isEmpty()) {
          "No Activity must not register a listener."
        }
        activityPresent = true
        port.value = absent
        check(observer.observe(16)["vpn"] == "absent") { "NOT_VPN must classify only the synthetic default network." }
        observer.destroy()
        check(port.registered.isEmpty()) { "Destruction must release the listener." }
        check(observer.snapshot(16)["reason"] == "inactive") { "Destroyed observation must not expose a snapshot." }
        port.failRegistration = true
        check(observer.observe(17)["reason"] == "unavailable") { "Registration failure must fail closed." }
        check(port.registered.isEmpty()) { "Partially registered listener must be cleaned up on failure." }
        check(emitted.all { it.keys == setOf("version", "scope", "generation", "sequence", "vpn", "reason") }) {
          "Native events must contain only the metadata contract."
        }
        check(emitted.none { it.toString().contains("synthetic-private-boundary") }) { "Android exceptions must not leak." }
      }
    } finally {
      runOnMainSync { observer.destroy(); check(port.registered.isEmpty()) { "Runner cleanup must release every synthetic listener." } }
    }
  }

  // AOSP Network parcels contain a single network ID. Creating the object performs no network I/O.
  private fun syntheticNetwork(id: Int): Network {
    val parcel = Parcel.obtain()
    return try {
      parcel.writeInt(id)
      parcel.setDataPosition(0)
      Network.CREATOR.createFromParcel(parcel)
    } finally { parcel.recycle() }
  }

  // Only manager operations and capability accessors are fake; callbacks and Android objects are real.
  private class SyntheticNetwork(
    private val network: Network,
    private val vpn: NetworkCapabilities,
    private val absent: NetworkCapabilities,
  ) : VpnNetworkPort {
    var value = vpn
    val registered = mutableSetOf<ConnectivityManager.NetworkCallback>()
    var reads = 0
    var failRegistration = false
    override fun activeNetwork(): Network { reads++; return network }
    override fun capabilities(network: Network): NetworkCapabilities { reads++; return value }
    override fun hasTransport(value: NetworkCapabilities, transport: Int): Boolean {
      check(value === vpn || value === absent) { "Undeclared synthetic capabilities." }
      return value === vpn && transport == NetworkCapabilities.TRANSPORT_VPN
    }
    override fun hasCapability(value: NetworkCapabilities, capability: Int): Boolean {
      check(value === vpn || value === absent) { "Undeclared synthetic capabilities." }
      return value === absent && capability == NetworkCapabilities.NET_CAPABILITY_NOT_VPN
    }
    override fun register(callback: ConnectivityManager.NetworkCallback) {
      registered.add(callback)
      if (failRegistration) throw IllegalStateException("synthetic-private-boundary")
    }
    override fun unregister(callback: ConnectivityManager.NetworkCallback) { registered.remove(callback) }
  }
}
