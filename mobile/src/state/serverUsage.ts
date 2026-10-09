import { useEffect, useMemo, useState } from 'react';
import type { RelayClient } from '@/core/client';
import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import type { ServerUsage, UsagePeriod } from '../../../protocol/serverUsage';
import { parseUsageCache, usageCache, USAGE_PERIODS } from '@/core/serverUsage';
import { useApp } from './app';
import { load, save } from './storage';

const cacheWrites = new Map<string, Promise<void>>();
function writeUsageCache(key: string, value: string): Promise<void> {
  // The last operation for a rejected scope must be its purge, not an older native write.
  const pending = (cacheWrites.get(key) ?? Promise.resolve()).then(() => save(key, value));
  cacheWrites.set(key, pending);
  void pending.finally(() => { if (cacheWrites.get(key) === pending) cacheWrites.delete(key); }).catch(() => {});
  return pending;
}

type Report = { data: ServerUsage | null; stale: boolean; loading: boolean; error: ConnectionDiagnosis | null };
const initial = (): Record<UsagePeriod, Report> => Object.fromEntries(USAGE_PERIODS.map(period=>[period,{data:null,stale:false,loading:true,error:null}])) as Record<UsagePeriod,Report>;
function deniedReports(cause: ConnectionDiagnosis): Record<UsagePeriod, Report> {
  return Object.fromEntries(USAGE_PERIODS.map(period => [period, { data:null, stale:false, loading:false, error:cause }])) as Record<UsagePeriod, Report>;
}
export function useServerUsage(serverId: string) {
  const { ready, servers, clientFor, snapshot } = useApp();
  const server = servers.find(s=>s.id===serverId);
  const source = server ? `${server.id}|${server.url}|${server.deviceId}` : '';
  const client = useMemo(()=>clientFor(serverId),[clientFor,serverId]);
  const down = snapshot(serverId).down;
  const rejected = down?.action === 'pair';
  const [revision,setRevision] = useState(0);
  const [state,setState] = useState<{source:string;client:RelayClient | null;reports:Record<UsagePeriod,Report>}>({source:'',client:null,reports:initial()});
  useEffect(()=>{
    if(!ready || !source) return;
    if (rejected) {
      const reports = deniedReports(down);
      let active = true;
      void Promise.resolve().then(() => { if (active) setState({source,client,reports}); });
      void Promise.all(USAGE_PERIODS.map(period => writeUsageCache(`relay.usage.v1.${encodeURIComponent(serverId)}.${period}`, '')));
      return () => { active = false; };
    }
    let active = true;
    let denied: ConnectionDiagnosis | null = null;
    const matching = (previous: typeof state) => previous.source === source && previous.client === client;
    const cacheKey = (period: UsagePeriod) => `relay.usage.v1.${encodeURIComponent(serverId)}.${period}`;
    void Promise.all(USAGE_PERIODS.map(async period=>{
      const key = cacheKey(period);
      await cacheWrites.get(key);
      const cached = parseUsageCache(await load(key),source,period);
      if(!active || denied) return;
      setState(previous=>({source,client,reports:{...(matching(previous)?previous.reports:initial()),[period]:{data:matching(previous)?previous.reports[period].data??cached:cached,stale:!!cached,loading:true,error:null}}}));
      try {
        const data = await client.usage(period);
        if(!active || denied) return;
        setState(previous=>({source,client,reports:{...(matching(previous)?previous.reports:initial()),[period]:{data,stale:false,loading:false,error:null}}}));
        await writeUsageCache(key,usageCache(source,data));
      } catch (failure) {
        const cause = classifyConnectionError(failure);
        if (active && cause.action === 'pair') {
          denied = cause;
          const reports = deniedReports(cause);
          setState({source,client,reports});
          await Promise.all(USAGE_PERIODS.map(value => writeUsageCache(cacheKey(value), '')));
          return;
        }
        if(!active || denied) return;
        setState(previous=>({source,client,reports:{...(matching(previous)?previous.reports:initial()),[period]:{data:matching(previous) ? previous.reports[period].data ?? cached : cached,stale:true,loading:false,error:cause}}}));
      }
    })).then(async () => {
      // A cache write already in flight must finish before the final revocation purge.
      if (denied) await Promise.all(USAGE_PERIODS.map(period => writeUsageCache(cacheKey(period), '')));
    });
    return ()=>{active=false;};
  },[ready,source,serverId,client,revision,rejected,down]);
  const reports = state.source===source && state.client===client ? state.reports : initial();
  const errors = USAGE_PERIODS.map(period => reports[period].error);
  const diagnosis = rejected ? down : errors.find(error => error?.action === 'pair')
    ?? (down?.kind === 'known' ? down : null)
    ?? errors.find(error => error?.kind === 'known')
    ?? errors.find(Boolean) ?? down ?? null;
  return { reports:rejected ? deniedReports(down) : reports, diagnosis, reload:()=>setRevision(n=>n+1) };
}
