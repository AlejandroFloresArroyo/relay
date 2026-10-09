package relay.boardweb

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.*
import android.webkit.WebView

/** Feasibility probe only; no production writer, permission grant or network/config change. */
class IsolatedWebViewProbeService : Service() {
  private val messenger by lazy { Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      val result = Bundle()
      result.putBoolean("internetDenied", checkSelfPermission("android.permission.INTERNET") == PackageManager.PERMISSION_DENIED)
      try { WebView(this@IsolatedWebViewProbeService).destroy(); result.putString("constructor", "initialized") }
      catch (_: Throwable) { result.putString("constructor", "not_initialized") }
      val reply = Message.obtain(null, 1).apply { data = result }
      try { message.replyTo?.send(reply) } catch (_: Exception) {}
    }
  }) }
  override fun onBind(intent: Intent?): IBinder = messenger.binder
}
