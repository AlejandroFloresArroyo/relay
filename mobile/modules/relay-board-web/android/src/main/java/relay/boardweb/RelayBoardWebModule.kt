package relay.boardweb

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher

internal object BoardWebViews {
  private val views = mutableSetOf<RelayBoardWebView>()
  fun add(view: RelayBoardWebView) { synchronized(views) { views.add(view) } }
  fun remove(view: RelayBoardWebView) { synchronized(views) { views.remove(view) } }
  fun retire(generation: String) {
    val action = { synchronized(views) { views.toList() }.filter { it.generation == generation }.forEach { it.clear() } }
    if (Looper.myLooper() == Looper.getMainLooper()) action() else Handler(Looper.getMainLooper()).post { action() }
  }
}
class RelayBoardWebView internal constructor(context: Context, appContext: AppContext, private val verifyProvider: (Context) -> Unit) : ExpoView(context, appContext) {
  constructor(context: Context, appContext: AppContext) : this(context, appContext, BoardWebCapability::requireVerified)
  private val onFailure by EventDispatcher<Map<String, String>>()
  private var engine: WebView? = null
  var generation: String? = null; private set
  private var snapshotId: String? = null
  init { clipChildren = true; BoardWebViews.add(this) }
  fun show(id: String) {
    if (snapshotId == id) return
    clear()
    try {
      verifyProvider(context)
      val snapshot = BoardWebStore.get(id) ?: error("board_web_retired")
      snapshotId = id; generation = snapshot.generation
      BoardWebViews.add(this)
      engine = BoardWebIsolation.create(context, snapshot).also { addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
      if (snapshot.retired) clear()
    } catch (_: Throwable) { clear(); onFailure(mapOf("code" to "board_web_render_failed")) }
  }
  fun clear() {
    engine?.let { removeView(it); BoardWebIsolation.destroy(it) }; engine = null
    snapshotId?.let { BoardWebStore.remove(it) }; snapshotId = null; generation = null
  }
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) generation?.let { BoardWebStore.retire(it) }
    super.onWindowFocusChanged(hasFocus)
  }
  override fun onDetachedFromWindow() { clear(); BoardWebViews.remove(this); super.onDetachedFromWindow() }
}
class RelayBoardWebModule : Module() {
  private fun context(): Context = appContext.reactContext ?: error("board_web_unavailable")
  override fun definition() = ModuleDefinition {
    Name("RelayBoardWeb")
    Function("capability") { BoardWebCapability.snapshot(context()) }
    Function("beginGeneration") { BoardWebCapability.requireVerified(context()); BoardWebStore.begin() }
    Function("retireGeneration") { generation: String -> BoardWebStore.retire(generation) }
    AsyncFunction("createSnapshot") { generation: String, revision: String, canonical: String ->
      BoardWebCapability.requireVerified(context()); BoardWebStore.create(generation, revision, canonical)
    }
    AsyncFunction("putAsset") { generation: String, id: String, name: String, encoded: String ->
      BoardWebCapability.requireVerified(context()); BoardWebStore.put(generation, id, name, encoded)
    }
    AsyncFunction("sealSnapshot") { generation: String, id: String ->
      BoardWebCapability.requireVerified(context()); BoardWebStore.seal(generation, id)
    }
    OnActivityEntersBackground { BoardWebStore.background() }
    OnActivityEntersForeground { BoardWebStore.resume() }
    OnActivityDestroys { BoardWebStore.background() }
    OnDestroy { BoardWebStore.background() }
    View(RelayBoardWebView::class) {
      Events("onFailure")
      Prop("snapshotId") { view: RelayBoardWebView, id: String -> view.show(id) }
      OnViewDestroys { view: RelayBoardWebView -> view.clear(); BoardWebViews.remove(view) }
    }
  }
}
