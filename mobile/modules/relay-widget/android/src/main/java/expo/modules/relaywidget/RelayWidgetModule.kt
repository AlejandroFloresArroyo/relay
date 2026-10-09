package expo.modules.relaywidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class RelayWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RelayWidget")
    Events("openRequested")
    // The Servidor the widget follows, or null. Only names cross; the key stays in the Avisos snapshot.
    Function("target") { raw: String? ->
      val context = requireNotNull(appContext.reactContext).applicationContext
      val next = raw?.let { WidgetStore.parseTarget(JSONObject(it)) ?: throw IllegalArgumentException("Invalid widget target") }
      if (WidgetStore.setTarget(context, next)) WidgetLive.refreshAsync(context)
      RelayWidgetProvider.refresh(context)
    }
    Function("takeOpenRequest") { WidgetOpen.take() }
    OnNewIntent { sendEvent("openRequested") }
  }
}
