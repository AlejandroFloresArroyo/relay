package expo.modules.relayvpn

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RelayVpnStatusModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val observation = VpnObservation(
    connect = {
      (appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
        ?.let { AndroidVpnNetwork(it) }
    },
    activityPresent = { appContext.currentActivity != null },
    post = { action -> main.post { action() } },
    emit = { reading -> sendEvent("onNetworkChanged", reading) },
  )

  override fun definition() = ModuleDefinition {
    Name("RelayVpnStatus")
    Events("onNetworkChanged")
    AsyncFunction("observe") { requested: Int -> observation.observe(requested) }.runOnQueue(Queues.MAIN)
    AsyncFunction("snapshot") { requested: Int -> observation.snapshot(requested) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { requested: Int -> observation.stop(requested); Unit }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground { main.post { observation.setForeground(true) } }
    OnActivityEntersBackground { main.post { observation.setForeground(false) } }
    OnActivityDestroys { main.post { observation.setForeground(false) } }
    OnDestroy { main.post { observation.destroy() } }
  }
}

// The seam controls only Android connectivity operations; observation logic remains shared and real.
internal interface VpnNetworkPort {
  fun activeNetwork(): Network?
  fun capabilities(network: Network): NetworkCapabilities?
  fun hasTransport(value: NetworkCapabilities, transport: Int): Boolean
  fun hasCapability(value: NetworkCapabilities, capability: Int): Boolean
  fun register(callback: ConnectivityManager.NetworkCallback)
  fun unregister(callback: ConnectivityManager.NetworkCallback)
}

private class AndroidVpnNetwork(private val manager: ConnectivityManager) : VpnNetworkPort {
  override fun activeNetwork() = manager.activeNetwork
  override fun capabilities(network: Network) = manager.getNetworkCapabilities(network)
  override fun hasTransport(value: NetworkCapabilities, transport: Int) = value.hasTransport(transport)
  override fun hasCapability(value: NetworkCapabilities, capability: Int) = value.hasCapability(capability)
  override fun register(callback: ConnectivityManager.NetworkCallback) = manager.registerDefaultNetworkCallback(callback)
  override fun unregister(callback: ConnectivityManager.NetworkCallback) = manager.unregisterNetworkCallback(callback)
}

internal class VpnObservation(
  private val connect: () -> VpnNetworkPort?,
  private val activityPresent: () -> Boolean,
  private val post: (() -> Unit) -> Unit,
  private val emit: (Map<String, Any>) -> Unit,
) {
  private var foreground = true
  private var generation = 0
  private var sequence = 0L
  private var manager: VpnNetworkPort? = null
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var currentNetwork: Network? = null
  private var capabilities: NetworkCapabilities? = null
  private var blocked: Boolean? = null

  fun stop(requested: Int) { if (requested == generation) retire() }
  fun setForeground(value: Boolean) { foreground = value; if (!value) retire() }
  fun destroy() { retire() }

  private fun reading(vpn: String, reason: String, requested: Int = generation) = mapOf(
    "version" to 1, "scope" to "relay-default-network", "generation" to requested,
    "sequence" to sequence, "vpn" to vpn, "reason" to reason
  )

  private fun publish(vpn: String, reason: String) {
    sequence += 1
    emit(reading(vpn, reason))
  }

  private fun classify(value: NetworkCapabilities?): Pair<String, String> {
    val connectivity = manager
    if (value == null || connectivity == null) return "unknown" to "unavailable"
    val vpn = connectivity.hasTransport(value, NetworkCapabilities.TRANSPORT_VPN)
    val notVpn = connectivity.hasCapability(value, NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
    return when {
      vpn && !notVpn -> "available" to "capabilities"
      !vpn && notVpn -> "absent" to "capabilities"
      else -> "unknown" to "unavailable"
    }
  }

  private fun retire() {
    val previous = callback
    callback = null; currentNetwork = null; capabilities = null; blocked = null
    try { if (previous != null) manager?.unregister(previous) } catch (_: Exception) { }
    manager = null
    if (generation > 0) publish("unknown", "inactive")
  }

  fun observe(requested: Int): Map<String, Any> {
    retire(); generation = requested; sequence = 0
    if (requested < 1 || !foreground || !activityPresent()) return reading("unknown", "inactive")
    if (Build.VERSION.SDK_INT < 24) return reading("unknown", "unavailable")
    try {
      val connectivity = connect()
        ?: return reading("unknown", "unavailable")
      manager = connectivity
      val observer = object : ConnectivityManager.NetworkCallback() {
        private fun accept(action: () -> Unit) {
          post { if (foreground && requested == generation && callback === this) action() }
        }
        override fun onAvailable(network: Network) = accept {
          currentNetwork = network; capabilities = null; blocked = null
          publish("unknown", "transition")
        }
        override fun onCapabilitiesChanged(network: Network, value: NetworkCapabilities) = accept {
          if (network == currentNetwork) {
            capabilities = value
            val result = when (blocked) {
              true -> "unknown" to "blocked"
              false -> classify(value)
              null -> "unknown" to "transition"
            }
            publish(result.first, result.second)
          }
        }
        override fun onBlockedStatusChanged(network: Network, value: Boolean) = accept {
          if (network == currentNetwork) {
            blocked = value
            val result = if (value) "unknown" to "blocked" else classify(capabilities)
            publish(result.first, result.second)
          }
        }
        override fun onLost(network: Network) = accept {
          if (network == currentNetwork) {
            currentNetwork = null; capabilities = null; blocked = null
            publish("unknown", "no-default-or-blocked")
          }
        }
      }
      callback = observer
      // Callback arguments are ordered; no synchronous network query is made inside callbacks.
      connectivity.register(observer)
      return snapshot(requested)
    } catch (_: Exception) {
      retire()
      return reading("unknown", "unavailable")
    }
  }

  fun snapshot(requested: Int): Map<String, Any> {
    if (requested != generation || !foreground || callback == null) return reading("unknown", "inactive", requested)
    return try {
      val connectivity = manager ?: return reading("unknown", "unavailable")
      if (blocked == true) return reading("unknown", "blocked")
      val network = connectivity.activeNetwork() ?: return reading("unknown", "no-default-or-blocked")
      val value = connectivity.capabilities(network)
      if (connectivity.activeNetwork() != network) return reading("unknown", "transition")
      val result = classify(value)
      reading(result.first, result.second)
    } catch (_: Exception) { reading("unknown", "unavailable") }
  }
}
