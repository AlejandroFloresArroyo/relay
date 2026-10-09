/** Convert a Puente epoch deadline to the phone clock using the sample at arrival. */
export function approvalDeadline(expiresAt: number | null, clockOffsetMs = 0): number | null {
  return expiresAt === null ? null : expiresAt + clockOffsetMs;
}
