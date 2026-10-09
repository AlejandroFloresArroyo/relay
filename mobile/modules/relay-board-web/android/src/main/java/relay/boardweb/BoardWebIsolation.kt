package relay.boardweb

import android.content.Context
import android.graphics.Bitmap
import android.os.Message
import android.view.View
import android.webkit.*
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicBoolean

internal object BoardWebIsolation {
  const val WRAPPER = "__relay_wrapper__"
  private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(byteArrayOf()))
  private fun policy(origin: String, wrapper: Boolean): String =
    "default-src 'none'; script-src $origin; style-src 'unsafe-inline' $origin; img-src $origin; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src ${if (wrapper) origin else "'none'"}; object-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block';" + if (wrapper) "" else " sandbox allow-scripts;"
  /** Also used by the native matrix; it never disables one of the product's guards. */
  fun create(context: Context, snapshot: BoardWebSnapshot, probe: ((String) -> Unit)? = null, imageResponseProbe: (() -> Unit)? = null): WebView {
    val origin = "https://b-${snapshot.id}.relay.invalid"
    CookieManager.getInstance().setAcceptCookie(false)
    ServiceWorkerController.getInstance().apply {
      serviceWorkerWebSettings.apply { blockNetworkLoads = true; allowFileAccess = false; allowContentAccess = false; cacheMode = WebSettings.LOAD_NO_CACHE }
      setServiceWorkerClient(object : ServiceWorkerClient() { override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse = denied() })
    }
    val framePending = AtomicBoolean(true)
    return WebView(context).apply {
      CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
      settings.apply {
        // Let images reach the local interceptor; network loads and all fallback responses remain denied.
        blockNetworkLoads = true; blockNetworkImage = false; cacheMode = WebSettings.LOAD_NO_CACHE
        allowFileAccess = false; allowContentAccess = false; allowFileAccessFromFileURLs = false; allowUniversalAccessFromFileURLs = false
        domStorageEnabled = false; databaseEnabled = false; mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        mediaPlaybackRequiresUserGesture = true; setGeolocationEnabled(false); setSupportMultipleWindows(true); javaScriptCanOpenWindowsAutomatically = false
        javaScriptEnabled = true
      }
      isLongClickable = false; setOnLongClickListener { true }; setDownloadListener { _, _, _, _, _ -> }
      webChromeClient = object : WebChromeClient() {
        override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, result: Message): Boolean = false
        override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
        override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>, params: FileChooserParams): Boolean { callback.onReceiveValue(null); return true }
        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
        override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
        override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
        override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean { result.cancel(); return true }
        override fun onShowCustomView(view: View, callback: CustomViewCallback) { callback.onCustomViewHidden() }
        override fun onConsoleMessage(message: ConsoleMessage): Boolean { probe?.invoke(message.message()); return true }
      }
      webViewClient = object : WebViewClient() {
        private fun navigation(url: String, main: Boolean) = snapshot.retired || main || url != "$origin/index.html" || !framePending.compareAndSet(true, false)
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = navigation(request.url.toString(), request.isForMainFrame)
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = navigation(url, false)
        override fun onPageStarted(view: WebView, url: String, icon: Bitmap?) { if (snapshot.retired || url != "$origin/$WRAPPER") { view.stopLoading(); view.settings.javaScriptEnabled = false } }
        private fun resource(url: String, method: String): WebResourceResponse {
          if (snapshot.retired || method != "GET") return denied()
          val wrapper = url == "$origin/$WRAPPER"
          val name = if (url.startsWith("$origin/")) url.removePrefix("$origin/") else ""
          val metadata = snapshot.assets.find { it.name == name }
          val bytes = if (wrapper) "<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:white}iframe{display:block}</style><iframe sandbox=\"allow-scripts\" src=\"$origin/index.html\"></iframe>".toByteArray(Charsets.UTF_8) else synchronized(BoardWebStore) { snapshot.bytes[name] }
          if (snapshot.retired) return denied()
          if (!wrapper && (metadata == null || bytes == null || url != "$origin/${metadata.name}")) return denied()
          if (!wrapper && metadata!!.mime.startsWith("image/")) imageResponseProbe?.invoke()
          return WebResourceResponse(if (wrapper) "text/html" else metadata!!.mime, if (wrapper || metadata!!.mime.startsWith("text/") || metadata.mime == "application/javascript") "UTF-8" else null, 200, "OK",
            mapOf("Content-Security-Policy" to policy(origin, wrapper), "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff", "X-DNS-Prefetch-Control" to "off", "Permissions-Policy" to "camera=(), microphone=(), geolocation=(), display-capture=(), autoplay=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), hid=()"), ByteArrayInputStream(bytes!!))
        }
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = resource(request.url.toString(), request.method)
        override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse = resource(url, "GET")
      }
      loadUrl("$origin/$WRAPPER")
    }
  }
  fun destroy(view: WebView) {
    view.settings.javaScriptEnabled = false; view.stopLoading(); view.onPause(); view.removeAllViews(); view.destroy()
  }
}
