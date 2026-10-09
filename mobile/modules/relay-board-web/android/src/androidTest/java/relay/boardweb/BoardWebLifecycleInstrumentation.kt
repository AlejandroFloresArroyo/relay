package relay.boardweb

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.uimanager.ThemedReactContext
import expo.modules.kotlin.KotlinInteropModuleRegistry
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference

/** A private window for the standalone library test APK; it never launches Relay or ReactHost. */
class BoardWebLifecycleActivity : Activity() {
  lateinit var host: FrameLayout; private set
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    host = FrameLayout(this)
    setContentView(host)
  }
}

/** Only React/provider boundaries are synthetic; ExpoView, Android callbacks, store and WebView are real. */
class BoardWebLifecycleInstrumentation : Instrumentation() {
  private class FixedCheckFailure(val causeCode: String) : RuntimeException()
  private fun fixedCheck(condition: Boolean, cause: String) { if (!condition) throw FixedCheckFailure(cause) }
  private fun onMain(action: () -> Unit) {
    var failure: Throwable? = null
    runOnMainSync { try { action() } catch (error: Throwable) { failure = error } }
    failure?.let { throw it }
  }
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
  @Suppress("DEPRECATION")
  override fun onStart() {
    val result = Bundle()
    var activity: BoardWebLifecycleActivity? = null
    var registry: KotlinInteropModuleRegistry? = null
    var card: RelayBoardWebView? = null
    val generations = mutableListOf<String>()
    var secondId: String? = null
    var liveEngine: WebView? = null
    var liveSettings: WebSettings? = null
    var retained: BoardWebSnapshot? = null
    var failure: Throwable? = null
    var phase = "qa-target"
    fun snapshot(): Pair<String, String> {
      val bytes = "<p>OK</p>".toByteArray(Charsets.UTF_8)
      val canonical = "{\"schemaVersion\":1,\"entry\":\"index.html\",\"files\":[{\"name\":\"index.html\",\"mime\":\"text/html\",\"bytes\":9,\"sha256\":\"${BoardWebStore.sha(bytes)}\"}]}"
      val generation = BoardWebStore.begin().also { generations.add(it) }
      val id = BoardWebStore.create(generation, BoardWebStore.sha(canonical.toByteArray(Charsets.UTF_8)), canonical)
      BoardWebStore.put(generation, id, "index.html", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
      BoardWebStore.seal(generation, id)
      return generation to id
    }
    try {
      fixedCheck(targetContext.packageName == "relay.boardweb.test" && context.packageName == "relay.boardweb.test", "qa_target_forbidden")
      phase = "synthetic-activity"
      activity = startActivitySync(Intent(targetContext, BoardWebLifecycleActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as? BoardWebLifecycleActivity
      fixedCheck(activity != null, "lifecycle_activity_missing")
      waitForIdleSync()
      phase = "expo-bootstrap"
      onMain {
        com.facebook.soloader.SoLoader.init(targetContext, com.facebook.react.soloader.OpenSourceMergedSoMapping)
        val react = BridgeReactContext(targetContext)
        val modules = object : ModulesProvider {
          override fun getModulesMap(): Map<Class<out Module>, String?> = emptyMap()
        }
        val interop = KotlinInteropModuleRegistry(modules, expo.modules.core.ModuleRegistry(emptyList(), emptyList()), WeakReference(react))
        registry = interop
        val themed = ThemedReactContext(react, activity!!, "BoardWebLifecycleQA", -1)
        // No JS runtime, ReactHost, network client or provider authorization is installed by this fixture.
        card = RelayBoardWebView(themed, interop.appContext) { }
      }
      phase = "detach-reattach-snapshot"
      onMain {
        val view = card!!
        val host = activity!!.host
        host.addView(view, FrameLayout.LayoutParams(300, 300))
        fixedCheck(view.isAttachedToWindow, "lifecycle_not_attached")
        val first = snapshot()
        view.show(first.second)
        fixedCheck(view.generation == first.first && view.childCount == 1, "lifecycle_initial_snapshot_missing")
        val firstSettings = (view.getChildAt(0) as WebView).settings
        host.removeView(view)
        fixedCheck(!view.isAttachedToWindow && view.childCount == 0 && view.generation == null && !firstSettings.javaScriptEnabled && BoardWebStore.get(first.second) == null, "lifecycle_detach_not_cleared")
        BoardWebStore.retire(first.first)
        host.addView(view, FrameLayout.LayoutParams(300, 300))
        fixedCheck(view.isAttachedToWindow, "lifecycle_not_attached")
        val second = snapshot()
        secondId = second.second
        view.show(second.second)
        fixedCheck(view.generation == second.first && view.childCount == 1, "lifecycle_reattach_snapshot_missing")
        liveEngine = view.getChildAt(0) as WebView
        liveSettings = liveEngine!!.settings
        retained = BoardWebStore.get(second.second)
        fixedCheck(liveSettings!!.javaScriptEnabled && retained != null && retained!!.bytes.isNotEmpty(), "lifecycle_reattach_snapshot_missing")
      }
      phase = "retire-generation"
      // Exercise the real off-main retire path; its clear is queued before the next main envelope.
      BoardWebStore.retire(generations.last())
      onMain {
        fixedCheck(card!!.childCount == 0 && card!!.generation == null && liveEngine!!.parent == null, "lifecycle_retire_not_cleared")
        fixedCheck(!liveSettings!!.javaScriptEnabled, "lifecycle_retire_js_enabled")
        fixedCheck(BoardWebStore.get(secondId!!) == null && retained!!.retired && retained!!.bytes.isEmpty(), "lifecycle_retire_bytes_live")
      }
    } catch (error: Throwable) { failure = error }
    finally {
      // Cleanup failures never replace the original causal assertion packet.
      try {
        generations.forEach { BoardWebStore.retire(it) }
        onMain {
          card?.clear()
          card?.let { (it.parent as? android.view.ViewGroup)?.removeView(it) }
          registry?.onDestroy()
          activity?.finish()
        }
      } catch (error: Throwable) { if (failure == null) { failure = error; phase = "cleanup" } }
    }
    result.putString("phase", phase)
    if (failure == null) {
      result.putString("nativeLifecycle", "detach-reattach-retire-pass")
      result.putString("matrix", "lifecycle-only-no-egress-claim")
      finish(Activity.RESULT_OK, result)
    } else {
      result.putString("cause", (failure as? FixedCheckFailure)?.causeCode ?: if (phase == "expo-bootstrap") "native_bootstrap_unavailable" else "native_fixture_failed")
      result.putString("matrix", "fail-or-inconclusive-do-not-activate")
      finish(Activity.RESULT_CANCELED, result)
    }
  }
}
