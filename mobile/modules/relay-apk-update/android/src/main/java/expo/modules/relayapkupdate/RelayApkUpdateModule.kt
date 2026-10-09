package expo.modules.relayapkupdate

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.system.Os
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

private class Retired : Exception()
class ApkArtifact : Record {
  @Field var applicationId: String = ""
  @Field var versionCode: Long = 0
  @Field var versionName: String = ""
  @Field var byteLength: Long = 0
  @Field var sha256: String = ""
  @Field var signerSha256: String = ""
}
private class Completion(private val promise: Promise) {
  private val settled = AtomicBoolean(false)
  fun resolve() { if (settled.compareAndSet(false, true)) promise.resolve(null) }
  fun reject(code: String, message: String) { if (settled.compareAndSet(false, true)) promise.reject(code, message, null) }
  fun fail(error: Throwable) { reject(if (error is Retired) "cancelled" else "app_update_invalid", if (error is Retired) "Descarga cancelada." else "No se pudo verificar o preparar el APK.") }
}
private class Candidate(val token: String, val context: Context, val activity: () -> Activity?) {
  val createdAt = SystemClock.elapsedRealtime()
  var file: File? = null
  var output: FileOutputStream? = null
  var expected: ApkArtifact? = null
  var written = 0L
  var verified = false
  var sessionId: Int? = null
  var completion: Completion? = null
  var handed = false
}
private fun signer(info: PackageInfo): String {
  val signing = info.signingInfo ?: error("Invalid signer")
  return ApkVerification.signer(signing.hasMultipleSigners(), signing.apkContentsSigners.map { it.toByteArray() }.toTypedArray())
}
private fun sessionJournal(context: Context) = File(context.cacheDir, "relay-apk-private/active-session.id")
private fun installed(context: Context) = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
private fun sameInstalled(context: Context, expected: ApkArtifact) {
  check(Build.VERSION.SDK_INT >= 31)
  val current = installed(context)
  ApkVerification.sameInstalled(expected.applicationId, expected.versionCode, expected.signerSha256, context.packageName, current.longVersionCode, signer(current), context.packageManager.canRequestPackageInstalls())
}
private fun invalid(promise: Promise, error: Throwable) {
  promise.reject(if (error is Retired) "cancelled" else "app_update_invalid", if (error is Retired) "Descarga cancelada." else "No se pudo verificar o preparar el APK.", null)
}
private fun safe(promise: Promise, operation: () -> Any?) { try { promise.resolve(operation()) } catch (error: Throwable) { invalid(promise, error) } }

/** Only one private candidate exists; invalidation is synchronous and permanent. */
private object Candidates {
  val lock = Any()
  var active: Candidate? = null
  @Volatile var foreground = true
  fun guard(token: String): Candidate = synchronized(lock) {
    val candidate = active ?: throw Retired()
    if (candidate.token != token || SystemClock.elapsedRealtime() - candidate.createdAt >= 600000L || !foreground || candidate.activity()?.window?.decorView?.hasWindowFocus() != true) throw Retired()
    candidate
  }
  fun retire(token: String? = null): Unit = synchronized(lock) {
    val candidate = active ?: return@synchronized
    if (token != null && candidate.token != token) return@synchronized
    active = null
    try { candidate.output?.close() } catch (_: Throwable) { }
    candidate.output = null
    try { candidate.file?.delete() } catch (_: Throwable) { }
    if (!candidate.handed) {
      candidate.sessionId?.let { try { candidate.context.packageManager.packageInstaller.abandonSession(it) } catch (_: Throwable) { } }
      candidate.completion?.reject("cancelled", "Descarga cancelada.")
    }
    candidate.completion = null
    try { sessionJournal(candidate.context).delete() } catch (_: Throwable) { }
    Unit
  }
  fun confirm(context: Context, intent: Intent) = synchronized(lock) {
    val token = intent.getStringExtra("relay-apk-token") ?: return@synchronized
    val candidate = try { guard(token) } catch (_: Throwable) { retire(token); return@synchronized }
    if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != candidate.sessionId) return@synchronized
    if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) != PackageInstaller.STATUS_PENDING_USER_ACTION) {
      candidate.completion?.reject("app_update_invalid", "Android no pudo preparar la confirmación de instalación.")
      retire(token); return@synchronized
    }
    try {
      sameInstalled(context, candidate.expected ?: error("Missing APK"))
      val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: error("Missing confirmation")
      val activity = candidate.activity() ?: throw Retired()
      guard(token)
      // Android now owns its copied bytes. Lifecycle retirement must not cancel a
      // confirmation already handed to the person; it still requires Android consent.
      candidate.handed = true
      activity.startActivity(confirmation)
      try { sessionJournal(candidate.context).delete() } catch (_: Throwable) { }
      try { candidate.file?.delete() } catch (_: Throwable) { }
      candidate.completion?.resolve(); candidate.completion = null
    } catch (error: Throwable) { candidate.handed = false; candidate.completion?.fail(error); retire(token) }
  }
}
class ApkInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) { Candidates.confirm(context, intent) }
}
class RelayApkUpdateModule : Module() {
  private fun context() = appContext.reactContext ?: error("Missing context")
  override fun definition() = ModuleDefinition {
    Name("RelayApkUpdate")
    OnCreate {
      try {
      val journal = sessionJournal(context())
      if (journal.isFile && journal.length() <= 16) {
        val sessionId = journal.readText().trim().toIntOrNull()
        if (sessionId != null && context().packageManager.packageInstaller.mySessions.any { it.sessionId == sessionId && it.appPackageName == context().packageName }) {
          try { context().packageManager.packageInstaller.abandonSession(sessionId) } catch (_: Throwable) { }
        }
      }
      journal.delete()
      val directory = File(context().cacheDir, "relay-apk-private")
      // A cold process never resumes an old private candidate or installer intent.
      directory.listFiles()?.take(4)?.forEach { if (it.name.matches(Regex("[a-f0-9-]{36}\\.apk"))) it.delete() }
      } catch (_: Throwable) { /* A failed cleanup must never expose paths or prevent Relay startup. */ }
    }
    OnActivityEntersForeground { Candidates.foreground = true }
    OnActivityEntersBackground { Candidates.foreground = false; Candidates.retire() }
    OnActivityDestroys { Candidates.foreground = false; Candidates.retire() }
    OnDestroy { Candidates.retire() }
    Function("claim") {
      synchronized(Candidates.lock) {
        Candidates.retire()
        val candidate = Candidate(UUID.randomUUID().toString(), context()) { appContext.currentActivity }
        Candidates.active = candidate
        try { Candidates.guard(candidate.token) } catch (error: Throwable) { Candidates.retire(); throw error }
        candidate.token
      }
    }
    Function("retire") { token: String -> Candidates.retire(token) }
    AsyncFunction("info") { promise: Promise -> safe(promise) {
      val supported = Build.VERSION.SDK_INT >= 31
      val current = if (supported) installed(context()) else null
      mapOf("supported" to supported, "canInstall" to (supported && context().packageManager.canRequestPackageInstalls()),
        "applicationId" to context().packageName, "versionCode" to (current?.longVersionCode ?: 0L), "versionName" to (current?.versionName ?: ""),
        "signerSha256" to (current?.let { signer(it) } ?: ""))
    } }
    AsyncFunction("requestInstallPermission") { token: String, promise: Promise -> safe(promise) {
      val candidate = Candidates.guard(token); check(Build.VERSION.SDK_INT >= 31)
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${candidate.context.packageName}"))
      synchronized(Candidates.lock) { Candidates.guard(token).activity()!!.startActivity(intent) }
      null
    } }.runOnQueue(Queues.MAIN)
    AsyncFunction("open") { token: String, expected: ApkArtifact, promise: Promise -> safe(promise) {
      synchronized(Candidates.lock) {
        val candidate = Candidates.guard(token)
        check(candidate.file == null)
        ApkVerification.expected(expected.byteLength, expected.versionCode, expected.sha256, expected.signerSha256)
        sameInstalled(candidate.context, expected)
        val directory = File(candidate.context.cacheDir, "relay-apk-private"); check(directory.isDirectory || directory.mkdir()); Os.chmod(directory.path, 448)
        val file = File(directory, "$token.apk"); check(file.createNewFile()); candidate.file = file
        Os.chmod(file.path, 384); candidate.output = FileOutputStream(file); candidate.expected = expected
      }; null
    } }
    AsyncFunction("writeChunk") { token: String, values: List<Int>, promise: Promise -> safe(promise) {
      synchronized(Candidates.lock) {
        val candidate = Candidates.guard(token); val expected = candidate.expected ?: error("Missing APK")
        check(!candidate.verified && values.size in 1..65536 && values.all { it in 0..255 })
        check(candidate.written + values.size <= expected.byteLength && candidate.written + values.size <= ApkVerification.MAX_BYTES)
        candidate.output!!.write(ByteArray(values.size) { values[it].toByte() }); candidate.written += values.size
      }; null
    } }
    AsyncFunction("verify") { token: String, promise: Promise -> safe(promise) {
      val candidate = Candidates.guard(token); val expected = candidate.expected ?: error("Missing APK")
      synchronized(Candidates.lock) { Candidates.guard(token); check(candidate.written == expected.byteLength); candidate.output?.close(); candidate.output = null }
      val file = candidate.file ?: error("Missing file"); check(file.length() == expected.byteLength)
      FileInputStream(file).use { ApkVerification.stream(it, null, expected.byteLength, expected.sha256) { Candidates.guard(token) } }
      val archive = candidate.context.packageManager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: error("Invalid package")
      val certificate = signer(archive)
      ApkVerification.archive(expected.applicationId, expected.versionCode, expected.versionName, expected.signerSha256, archive.packageName, archive.longVersionCode, archive.versionName, certificate)
      sameInstalled(candidate.context, expected)
      synchronized(Candidates.lock) { Candidates.guard(token); candidate.verified = true }
      mapOf("applicationId" to archive.packageName, "versionCode" to archive.longVersionCode, "versionName" to archive.versionName,
        "byteLength" to expected.byteLength, "sha256" to expected.sha256, "signerSha256" to certificate)
    } }
    AsyncFunction("install") { token: String, promise: Promise ->
      val completion = Completion(promise)
      var sessionId: Int? = null
      try {
        val candidate = Candidates.guard(token); val expected = candidate.expected ?: error("Missing APK")
        check(candidate.verified && !candidate.handed && candidate.sessionId == null); sameInstalled(candidate.context, expected)
        val installer = candidate.context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(candidate.context.packageName); params.setSize(expected.byteLength)
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        val created = installer.createSession(params); sessionId = created
        synchronized(Candidates.lock) {
          Candidates.guard(token); candidate.sessionId = created
          val journal = sessionJournal(candidate.context); journal.writeText(created.toString()); Os.chmod(journal.path, 384)
        }
        installer.openSession(created).use { session ->
          session.openWrite("base.apk", 0, expected.byteLength).use { output ->
            FileInputStream(candidate.file ?: error("Missing file")).use { ApkVerification.stream(it, output, expected.byteLength, expected.sha256) { Candidates.guard(token) } }
            session.fsync(output)
          }
          sameInstalled(candidate.context, expected)
          val callback = Intent(candidate.context, ApkInstallReceiver::class.java).setData(Uri.parse("relay-apk:$token")).putExtra("relay-apk-token", token)
          val pending = PendingIntent.getBroadcast(candidate.context, 0, callback, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE)
          synchronized(Candidates.lock) { Candidates.guard(token); candidate.completion = completion; session.commit(pending.intentSender) }
        }
      } catch (error: Throwable) {
        sessionId?.let { try { context().packageManager.packageInstaller.abandonSession(it) } catch (_: Throwable) { } }
        Candidates.retire(token); completion.fail(error)
      }
    }
  }
}
