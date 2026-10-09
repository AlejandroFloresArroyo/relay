package relay.boardweb

/** Root may add an exact record only after the controlled native matrix passes. */
internal object VerifiedBoardWebProviders {
  data class Record(val packageName: String, val version: String, val versionCode: Long, val signer: String,
    val sdk: Int, val buildHash: String, val policyHash: String)
  // No engine has been run or verified by this worker. This is a runtime activation gate, not a completion claim.
  val records: List<Record> = emptyList()
}
