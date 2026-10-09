package relay.modules.share
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.system.Os
import android.view.WindowManager
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class ShareReceiverActivity : Activity() {
  companion object { private val copying = AtomicBoolean(false) }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    ShareInbox.initialize(cacheDir)
    if (!copying.compareAndSet(false, true)) { ShareInbox.add(mapOf("kind" to "rejected", "reason" to "busy"), null); openRelay(); finish(); return }
    val finished = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    val timeout = Runnable {
      if (finished.compareAndSet(false, true)) {
        ShareInbox.add(mapOf("kind" to "rejected"), null); openRelay(); finish()
      }
    }
    handler.postDelayed(timeout, 15000)
    Thread {
      var directory: File? = null
      var payload: Map<String, Any> = mapOf("kind" to "rejected")
      try {
        val incoming = intent
        val target = incoming.component
        val destination = target?.packageName == packageName && target.className == ShareReceiverActivity::class.java.name
        require(incoming.data == null && incoming.selector == null)
        require(incoming.flags and Intent.FLAG_GRANT_PREFIX_URI_PERMISSION == 0)
        val textValue = incoming.extras?.get(Intent.EXTRA_TEXT)
        require(textValue == null || textValue is CharSequence)
        val text = (textValue as? CharSequence)?.toString()
        val streamValue = incoming.extras?.get(Intent.EXTRA_STREAM)
        require(streamValue == null || streamValue is Uri)
        val uri = streamValue as? Uri
        val clips = incoming.clipData
        require(clips == null || clips.itemCount == 1)
        val clip = clips?.let { it.getItemAt(0) }
        require(clip?.intent == null)
        if (uri != null) require(clip != null && clip.uri == uri && clip.text == null)
        else require(clip?.uri == null && (clip?.text == null || clip?.text?.toString() == text))
        val grant = uri != null && incoming.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0
          && checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED
        val mime = incoming.type ?: ""
        SharePolicy.validate(incoming.action, mime, text, uri?.toString(), grant, if (uri == null) 0 else 1, destination)
        if (uri == null) payload = mapOf("kind" to "text", "text" to text!!)
        else {
          require(contentResolver.getType(uri) == mime)
          val root = File(cacheDir, "relay-share")
          require(root.exists() || root.mkdir()); Os.chmod(root.absolutePath, 448)
          // Our own app sandbox; never derived from a provider display name or external path.
          directory = File(root, UUID.randomUUID().toString()); require(directory!!.mkdir()); Os.chmod(directory!!.absolutePath, 448)
          val file = File(directory!!, "image")
          contentResolver.openInputStream(uri).use { input ->
            require(input != null)
            FileOutputStream(file).use { output -> Os.chmod(file.absolutePath, 384); SharePolicy.copy(input, output, SharePolicy.SOURCE_BYTES, mime) }
          }
          val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
          BitmapFactory.decodeFile(file.absolutePath, bounds)
          SharePolicy.dimensions(bounds.outWidth, bounds.outHeight)
          require(bounds.outMimeType == mime)
          payload = mapOf("kind" to "image", "uri" to Uri.fromFile(file).toString(), "width" to bounds.outWidth, "height" to bounds.outHeight)
        }
      } catch (_: Exception) { directory?.deleteRecursively(); directory = null }
      if (finished.compareAndSet(false, true)) {
        handler.removeCallbacks(timeout)
        ShareInbox.add(payload, directory)
        runOnUiThread { openRelay(); finish() }
      } else directory?.deleteRecursively()
      copying.set(false)
    }.apply { isDaemon = true; start() }
  }
  private fun openRelay() {
    // The launcher gets no raw content, URI, deep link or grant. JS asks the native inbox.
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      startActivity(it)
    }
  }
}
