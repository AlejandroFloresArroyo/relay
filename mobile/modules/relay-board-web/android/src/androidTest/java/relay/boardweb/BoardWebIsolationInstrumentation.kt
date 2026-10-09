package relay.boardweb

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import android.webkit.*
import java.io.ByteArrayInputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Root-only controlled loopback fixtures. No production destination, HTTP server or service discovery. */
class BoardWebIsolationInstrumentation : Instrumentation() {
  private var isolatedOnly = false
  private var lifecycleOnly = false
  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    isolatedOnly = arguments?.getString("isolatedProbeOnly") == "true"
    lifecycleOnly = arguments?.getString("lifecycleProbeOnly") == "true"
    start()
  }
  private fun isolatedProbe(): Bundle {
    val latch = CountDownLatch(1); var response: Bundle? = null
    val reply = android.os.Messenger(object : android.os.Handler(android.os.Looper.getMainLooper()) {
      override fun handleMessage(message: android.os.Message) { response = message.data; latch.countDown() }
    })
    val connection = object : android.content.ServiceConnection {
      override fun onServiceConnected(name: android.content.ComponentName, binder: android.os.IBinder) {
        android.os.Messenger(binder).send(android.os.Message.obtain(null, 1).apply { replyTo = reply })
      }
      override fun onServiceDisconnected(name: android.content.ComponentName) {}
    }
    check(targetContext.bindService(android.content.Intent(targetContext, IsolatedWebViewProbeService::class.java), connection, android.content.Context.BIND_AUTO_CREATE)) { "isolated_probe_not_bound" }
    try { check(latch.await(10, TimeUnit.SECONDS)) { "isolated_probe_timeout" }; return response ?: error("isolated_probe_missing") }
    finally { targetContext.unbindService(connection) }
  }
  private fun lifecycleProof() {
    val intent = targetContext.packageManager.getLaunchIntentForPackage(targetContext.packageName)
      ?: error("lifecycle_activity_missing")
    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    val activity = startActivitySync(intent)
    var registry: expo.modules.kotlin.KotlinInteropModuleRegistry? = null
    var host: android.widget.FrameLayout? = null
    var view: RelayBoardWebView? = null
    val generations = mutableListOf<String>()
    var lastSnapshotId: String? = null
    fun snapshot(): Pair<String, String> {
      val bytes = "<p>OK</p>".toByteArray(Charsets.UTF_8)
      val canonical = "{\"schemaVersion\":1,\"entry\":\"index.html\",\"files\":[{\"name\":\"index.html\",\"mime\":\"text/html\",\"bytes\":9,\"sha256\":\"${BoardWebStore.sha(bytes)}\"}]}"
      val generation = BoardWebStore.begin().also { generations.add(it) }
      val id = BoardWebStore.create(generation, BoardWebStore.sha(canonical.toByteArray(Charsets.UTF_8)), canonical)
      BoardWebStore.put(generation, id, "index.html", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
      BoardWebStore.seal(generation, id)
      lastSnapshotId = id
      return generation to id
    }
    try {
      waitForIdleSync()
      val application = activity.application as? com.facebook.react.ReactApplication ?: error("lifecycle_react_context_missing")
      var react: com.facebook.react.bridge.ReactApplicationContext? = null
      val deadline = android.os.SystemClock.uptimeMillis() + 10000
      while (react == null && android.os.SystemClock.uptimeMillis() < deadline) {
        runOnMainSync { react = application.reactHost?.currentReactContext as? com.facebook.react.bridge.ReactApplicationContext }
        if (react == null) Thread.sleep(50)
      }
      val fixtureReact = react ?: error("lifecycle_react_context_missing")
      runOnMainSync {
        val modules = object : expo.modules.kotlin.ModulesProvider {
          override fun getModulesMap(): Map<Class<out expo.modules.kotlin.modules.Module>, String?> = emptyMap()
        }
        val interop = expo.modules.kotlin.KotlinInteropModuleRegistry(modules,
          expo.modules.core.ModuleRegistry(emptyList(), emptyList()), java.lang.ref.WeakReference(fixtureReact))
        registry = interop
        val themed = com.facebook.react.uimanager.ThemedReactContext(fixtureReact, activity, "BoardWebLifecycleQA", -1)
        val parent = android.widget.FrameLayout(activity)
        host = parent
        (activity.window.decorView as android.view.ViewGroup).addView(parent,
          android.view.ViewGroup.LayoutParams(300, 300))
        // Only provider verification is a native boundary double; store, window callbacks and WebView are real.
        val card = RelayBoardWebView(themed, interop.appContext) { }
        view = card
        parent.addView(card, android.widget.FrameLayout.LayoutParams(300, 300))
        check(card.isAttachedToWindow) { "lifecycle_not_attached" }
        val first = snapshot()
        card.show(first.second)
        check(card.generation == first.first && card.childCount == 1) { "lifecycle_initial_snapshot_missing" }
        val firstSettings = (card.getChildAt(0) as WebView).settings
        parent.removeView(card)
        check(!card.isAttachedToWindow && card.childCount == 0 && card.generation == null && !firstSettings.javaScriptEnabled && BoardWebStore.get(first.second) == null) { "lifecycle_detach_not_cleared" }
        BoardWebStore.retire(first.first)
        parent.addView(card, android.widget.FrameLayout.LayoutParams(300, 300))
        check(card.isAttachedToWindow) { "lifecycle_not_attached" }
        val second = snapshot()
        card.show(second.second)
        check(card.generation == second.first && card.childCount == 1) { "lifecycle_reattach_snapshot_missing" }
      }
      val secondGeneration = generations.last()
      var engine: WebView? = null
      var settings: android.webkit.WebSettings? = null
      var retained: BoardWebSnapshot? = null
      runOnMainSync {
        engine = view!!.getChildAt(0) as WebView
        settings = engine!!.settings
        check(settings!!.javaScriptEnabled) { "lifecycle_reattach_snapshot_missing" }
        // Hold the snapshot so clearing the map alone cannot satisfy the byte-retirement assertion.
        retained = BoardWebStore.get(lastSnapshotId!!)
        check(retained != null && retained!!.bytes.isNotEmpty()) { "lifecycle_reattach_snapshot_missing" }
      }
      BoardWebStore.retire(secondGeneration)
      runOnMainSync {
        check(view!!.childCount == 0 && view!!.generation == null && engine!!.parent == null) { "lifecycle_retire_not_cleared" }
        check(!settings!!.javaScriptEnabled) { "lifecycle_retire_js_enabled" }
        check(retained!!.retired && retained!!.bytes.isEmpty()) { "lifecycle_retire_bytes_live" }
      }
    } finally {
      generations.forEach { BoardWebStore.retire(it) }
      runOnMainSync {
        view?.clear()
        host?.let { (it.parent as? android.view.ViewGroup)?.removeView(it) }
        registry?.onDestroy()
        activity.finish()
      }
    }
  }
  private fun storeProof() {
    val bytes = "<p>OK</p>".toByteArray(Charsets.UTF_8)
    val canonical = "{\"schemaVersion\":1,\"entry\":\"index.html\",\"files\":[{\"name\":\"index.html\",\"mime\":\"text/html\",\"bytes\":9,\"sha256\":\"${BoardWebStore.sha(bytes)}\"}]}"
    val generation = BoardWebStore.begin()
    try {
      val id = BoardWebStore.create(generation, BoardWebStore.sha(canonical.toByteArray(Charsets.UTF_8)), canonical)
      check(runCatching { BoardWebStore.put(generation, id, "index.html", android.util.Base64.encodeToString("<p>NO</p>".toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)) }.isFailure)
      check(BoardWebStore.get(id) == null)
      BoardWebStore.put(generation, id, "index.html", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
      BoardWebStore.seal(generation, id); check(BoardWebStore.get(id)?.bytes?.get("index.html")?.contentEquals(bytes) == true)
      BoardWebStore.retire(generation); check(BoardWebStore.get(id) == null)
      check(runCatching { BoardWebStore.create(generation, BoardWebStore.sha(canonical.toByteArray(Charsets.UTF_8)), canonical) }.isFailure)
    } finally { BoardWebStore.retire(generation) }
  }
  private class Counters : AutoCloseable {
    val tcp = AtomicInteger(); val udp = AtomicInteger()
    val server = ServerSocket().apply { bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)); soTimeout = 300 }
    val datagrams = DatagramSocket(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)).apply { soTimeout = 300 }
    @Volatile private var running = true
    private val tcpThread = Thread { while (running) { try { server.accept().use { tcp.incrementAndGet() } } catch (_: Exception) {} } }
    private val udpThread = Thread { while (running) { try { datagrams.receive(DatagramPacket(ByteArray(4096), 4096)); udp.incrementAndGet() } catch (_: Exception) {} } }
    init { tcpThread.start(); udpThread.start() }
    fun positive() {
      Socket().use { it.connect(InetSocketAddress("127.0.0.1", server.localPort), 1000) }
      DatagramSocket().use { it.send(DatagramPacket(byteArrayOf(1), 1, InetAddress.getByName("127.0.0.1"), datagrams.localPort)) }
      Thread.sleep(500); check(tcp.get() > 0 && udp.get() > 0) { "counter_positive_control_failed" }
      tcp.set(0); udp.set(0)
    }
    override fun close() { running = false; server.close(); datagrams.close(); tcpThread.join(1500); udpThread.join(1500) }
  }
  private fun fixture(counters: Counters): BoardWebSnapshot {
    val canary = java.io.File(targetContext.cacheDir, "relay-board-web-file-fixture.txt").apply { writeText("relay-file-canary") }
    val html = context.assets.open("board-web/index.html").use { it.readBytes() }
    val css = context.assets.open("board-web/local.css").use { it.readBytes() }
    val image = context.assets.open("board-web/local.png").use { it.readBytes() }
    val source = context.assets.open("board-web/probe.js").use { it.readBytes() }
    val target = org.json.JSONObject().put("tcp", "https://127.0.0.1:${counters.server.localPort}/").put("tcpPort", counters.server.localPort).put("udp", counters.datagrams.localPort).put("file", "file://${canary.absolutePath}")
    val script = ("const RELAY_PROBE_TARGET=" + target.toString() + ";\n").toByteArray(Charsets.UTF_8) + source
    val files = listOf(BoardWebAsset("index.html", "text/html", html.size, BoardWebStore.sha(html)), BoardWebAsset("probe.js", "application/javascript", script.size, BoardWebStore.sha(script)), BoardWebAsset("local.css", "text/css", css.size, BoardWebStore.sha(css)), BoardWebAsset("local.png", "image/png", image.size, BoardWebStore.sha(image)))
    return BoardWebSnapshot(UUID.randomUUID().toString(), "native-test-only", files).apply { bytes["index.html"] = html; bytes["probe.js"] = script; bytes["local.css"] = css; bytes["local.png"] = image; sealed = true }
  }
  private fun runEngine(snapshot: BoardWebSnapshot, restricted: Boolean, evidence: Bundle): Map<String, Int> {
    val imageLoaded = CountDownLatch(1)
    val imageResponses = AtomicInteger()
    val imageErrors = AtomicInteger()
    val benign = CountDownLatch(1)
    val submitted = CountDownLatch(1)
    val attempts = AtomicInteger()
    val leaks = AtomicInteger()
    val offers = AtomicInteger()
    val probe: (String) -> Unit = { message ->
      when {
        message == "relay-board-web-probe:benign-counter-canvas" -> benign.countDown()
        message == "relay-board-web-probe:benign-local-image" -> imageLoaded.countDown()
        message == "relay-board-web-probe:benign-local-image-error" -> imageErrors.incrementAndGet()
        message == "relay-board-web-probe:matrix-submitted" -> submitted.countDown()
        message.startsWith("relay-board-web-probe:attempt:") -> attempts.incrementAndGet()
        message.startsWith("relay-board-web-probe:rtc-offer:") -> offers.incrementAndGet()
        message.matches(Regex("relay-board-web-probe:(file|cookie|storage|database|cache|geolocation|media)-leak")) -> leaks.incrementAndGet()
      }
    }
    var view: WebView? = null
    runOnMainSync {
      view = if (restricted) BoardWebIsolation.create(targetContext, snapshot, probe) { imageResponses.incrementAndGet() } else {
        // Baseline must generate real engine traffic; native sockets alone do not prove RTC execution.
        val origin = "https://b-${snapshot.id}.relay.invalid"
        WebView(targetContext).apply {
          settings.javaScriptEnabled = true; settings.blockNetworkLoads = false
          webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean { probe(message.message()); return true }
            override fun onJsAlert(view: WebView, url: String, text: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsConfirm(view: WebView, url: String, text: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsPrompt(view: WebView, url: String, text: String, defaultValue: String, result: JsPromptResult): Boolean { result.cancel(); return true }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
          }
          webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
              val name = request.url.toString().removePrefix("$origin/")
              val asset = snapshot.assets.find { it.name == name } ?: return null
              if (asset.mime.startsWith("image/")) imageResponses.incrementAndGet()
              return WebResourceResponse(asset.mime, "UTF-8", ByteArrayInputStream(snapshot.bytes[name]!!))
            }
          }
          loadUrl("$origin/index.html")
        }
      }
    }
    try {
      check(benign.await(10, TimeUnit.SECONDS)) { "benign_js_not_executed" }
      check(imageLoaded.await(10, TimeUnit.SECONDS)) { "local_image_not_executed" }
      check(submitted.await(10, TimeUnit.SECONDS)) { "matrix_not_executed" }
      Thread.sleep(10000)
      return mapOf("attempts" to attempts.get(), "leaks" to leaks.get(), "rtcOffers" to offers.get())
    } finally {
      val prefix = if (restricted) "restricted" else "baseline"
      evidence.putInt(prefix + "LocalImageResponses", imageResponses.get())
      evidence.putInt(prefix + "LocalImageErrors", imageErrors.get())
      runOnMainSync { view?.let { BoardWebIsolation.destroy(it) } }
      snapshot.retired = true; snapshot.bytes.clear()
    }
  }
  override fun onStart() {
    val result = Bundle()
    try {
      if (lifecycleOnly) {
        result.putString("phase", "native-view-lifecycle")
        lifecycleProof()
        result.putString("nativeLifecycle", "detach-reattach-retire-pass")
        result.putString("matrix", "lifecycle-only-no-egress-claim")
        finish(Activity.RESULT_OK, result)
        return
      }
      if (isolatedOnly) {
        result.putString("phase", "isolated-feasibility"); val probe = isolatedProbe(); result.putBoolean("internetDenied", probe.getBoolean("internetDenied")); result.putString("constructor", probe.getString("constructor"))
        result.putString("matrix", "feasibility-only-no-isolation-claim"); finish(Activity.RESULT_OK, result); return
      }
      result.putString("phase", "native-store"); storeProof(); result.putString("nativeStore", "hash-and-retirement-pass")
      result.putString("providerMetadata", BoardWebCapability.snapshot(targetContext).toString())
      result.putString("policyHash", targetContext.getString(R.string.relay_board_web_policy_sha256))
      Counters().use { counters ->
        result.putString("phase", "positive-counters"); counters.positive()
        result.putString("phase", "engine-baseline"); val baseline = runEngine(fixture(counters), false, result)
        result.putInt("baselineTcp", counters.tcp.get()); result.putInt("baselineUdp", counters.udp.get()); result.putInt("baselineRtcOffers", baseline["rtcOffers"]!!)
        check(counters.tcp.get() > 0 && counters.udp.get() > 0 && baseline["rtcOffers"]!! > 0) { "engine_baseline_inconclusive" }
        counters.tcp.set(0); counters.udp.set(0)
        result.putString("phase", "restricted-engine"); val restricted = runEngine(fixture(counters), true, result)
        result.putInt("restrictedTcp", counters.tcp.get()); result.putInt("restrictedUdp", counters.udp.get()); result.putInt("restrictedAttempts", restricted["attempts"]!!); result.putInt("restrictedLeaks", restricted["leaks"]!!)
        check(restricted["attempts"]!! >= 35 && restricted["leaks"] == 0 && counters.tcp.get() == 0 && counters.udp.get() == 0) { "isolation_not_proven" }
      }
      result.putString("matrix", "pass-controlled-loopback-only"); finish(Activity.RESULT_OK, result)
    } catch (error: Throwable) {
      val safe = setOf("counter_positive_control_failed", "benign_js_not_executed", "local_image_not_executed", "matrix_not_executed", "engine_baseline_inconclusive", "isolation_not_proven", "isolated_probe_not_bound", "isolated_probe_timeout", "isolated_probe_missing", "lifecycle_activity_missing", "lifecycle_react_context_missing", "lifecycle_not_attached", "lifecycle_initial_snapshot_missing", "lifecycle_detach_not_cleared", "lifecycle_reattach_snapshot_missing", "lifecycle_retire_not_cleared", "lifecycle_retire_js_enabled", "lifecycle_retire_bytes_live")
      result.putString("cause", if (error.message in safe) error.message else "native_probe_failed")
      result.putString("matrix", "fail-or-inconclusive-do-not-activate"); finish(Activity.RESULT_CANCELED, result) }
    finally { java.io.File(targetContext.cacheDir, "relay-board-web-file-fixture.txt").delete() }
  }
}
