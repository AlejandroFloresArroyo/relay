import { DECISION_HISTORY_LIMIT, DECISION_COMMAND_PREVIEW_LENGTH } from '../../protocol/protocol.ts';
import type { DecisionHistory, DecisionRecord, DecisionAttempt } from '../../protocol/protocol.ts';

/** A display projection only: neither the ledger nor unconfirmed choices are modified. */
export function decisionHistoryView(records: Iterable<DecisionRecord>, capturedAt: number, uncertain: DecisionAttempt[]): DecisionHistory {
  const recent: DecisionRecord[] = []; let total=0;
  for (const record of records) {
    total++;
    let low=0, high=recent.length;
    while (low < high) {
      const middle=(low+high)>>>1, other=recent[middle];
      if (other.at > record.at || other.at === record.at && other.id.localeCompare(record.id) <= 0) low=middle+1;
      else high=middle;
    }
    if (low >= DECISION_HISTORY_LIMIT) continue;
    recent.splice(low,0,record);
    if (recent.length > DECISION_HISTORY_LIMIT) recent.pop();
  }
  return { decisions:recent.map(record => record.command.length > DECISION_COMMAND_PREVIEW_LENGTH
    ? {...record,command:record.command.slice(0,DECISION_COMMAND_PREVIEW_LENGTH-1).replace(/[\uD800-\uDBFF]$/, '')+'…',commandTruncated:true} : {...record}),
    capturedAt,uncertain,window:{limit:DECISION_HISTORY_LIMIT,total} };
}
