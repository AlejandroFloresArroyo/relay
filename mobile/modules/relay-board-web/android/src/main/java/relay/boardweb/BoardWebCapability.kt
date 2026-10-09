package relay.boardweb

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView

internal object BoardWebCapability {
  fun snapshot(context: Context): Map<String, Any> {
    if (Build.VERSION.SDK_INT < 26) return mapOf("state" to "unsupported", "cause" to "provider_identity_unavailable")
    return try {
      val provider = WebView.getCurrentWebViewPackage() ?: return mapOf("state" to "unsupported", "cause" to "provider_missing")
      val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      val info = context.packageManager.getPackageInfo(provider.packageName, flags)
      val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
      val signer = signatures?.singleOrNull()?.let { BoardWebStore.sha(it.toByteArray()) } ?: return mapOf("state" to "unsupported", "cause" to "provider_identity_unavailable")
      val versionCode = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
      val policyHash = context.getString(R.string.relay_board_web_policy_sha256)
      val buildHash = BoardWebStore.sha(Build.FINGERPRINT.toByteArray(Charsets.UTF_8))
      val identity = mapOf("packageName" to provider.packageName, "version" to (info.versionName ?: ""), "versionCode" to versionCode, "signer" to signer, "sdk" to Build.VERSION.SDK_INT, "buildHash" to buildHash, "policyHash" to policyHash)
      val verified = VerifiedBoardWebProviders.records.any { it.packageName == provider.packageName && it.version == info.versionName && it.versionCode == versionCode && it.signer == signer && it.sdk == Build.VERSION.SDK_INT && it.buildHash == buildHash && it.policyHash == policyHash }
      mapOf("state" to if (verified) "verified" else "unverified", "cause" to if (verified) "native_matrix_verified" else "provider_unverified", "provider" to identity)
    } catch (_: Exception) { mapOf("state" to "unsupported", "cause" to "provider_identity_unavailable") }
  }
  fun requireVerified(context: Context) { check(snapshot(context)["state"] == "verified") { "board_web_isolation_unverified" } }
}
