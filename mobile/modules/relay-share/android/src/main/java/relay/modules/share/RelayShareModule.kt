package relay.modules.share
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
class RelayShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RelayShareReceiver")
    Events("pending")
    OnCreate { ShareInbox.changed = { sendEvent("pending", emptyMap<String, Any>()) } }
    OnDestroy { ShareInbox.changed = null }
    OnActivityEntersForeground { sendEvent("pending", emptyMap<String, Any>()) }
    AsyncFunction("pending") { ShareInbox.pending() }
    AsyncFunction("read") { token: String -> ShareInbox.read(token) }
    AsyncFunction("discard") { token: String -> ShareInbox.discard(token) }
  }
}
