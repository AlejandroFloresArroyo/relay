package expo.modules.relaywidget

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class RelayWidgetPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> {
    return listOf(object : ReactActivityLifecycleListener {
      // Expo constructs listeners before the Activity has an attached base context.
      private var context: Context? = null
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        val context = activity.applicationContext
        this.context = context
        WidgetOpen.capture(context, activity.intent)
      }
      override fun onDestroy(activity: Activity) { context = null }
      override fun onNewIntent(intent: Intent): Boolean = context?.let { WidgetOpen.capture(it, intent) } ?: false
    })
  }
}
