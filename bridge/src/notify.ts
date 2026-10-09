import type { Approval } from '../../protocol/protocol.ts';

export interface Notifier {
  approvalCreated(approval: Approval): Promise<void>;
}

// ntfy takes the title as an HTTP header, so it must be single-line ASCII.
function headerSafe(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

// Sends a push through ntfy (https://docs.ntfy.sh/publish/) when an approval is created.
// The flagged command is deliberately left out: whoever can read the topic would see it.
export function createNotifier(ntfyUrl: string | null, fetchFn: typeof fetch = fetch): Notifier {
  return {
    async approvalCreated(approval: Approval): Promise<void> {
      if (!ntfyUrl) return;
      const lines = [approval.risk?.summary ?? 'Un comando necesita tu aprobación'];
      if (approval.risk) lines.push(approval.risk.label);
      const response = await fetchFn(ntfyUrl, {
        method: 'POST',
        headers: {
          Title: headerSafe(`Relay: ${approval.agentName} espera aprobacion`),
          Priority: 'high',
          Tags: 'warning',
        },
        body: lines.join('\n'),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
    },
  };
}
