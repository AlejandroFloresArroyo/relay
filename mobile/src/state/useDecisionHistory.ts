import { useEffect, useRef, useState } from 'react';
import type { DecisionHistory } from '../../../protocol/protocol';
import { parseDecisionHistory } from '@/core/decisions';
import { RelayError } from '@/core/client';
import { useApp } from './app';

export function useDecisionHistory() {
  const { servers, clientFor } = useApp();
  const [entries,setEntries] = useState<Record<string,{signature:string; data:DecisionHistory|null; error:unknown; loading:boolean}>>({});
  const sequence = useRef(new Map<string,number>());
  const [attempt,setAttempt] = useState(0);
  // Callers of `reloaded` waiting for the next load to settle.
  const waiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    let active = true;
    // Retired identities must not retain private history in the hook's cache.
    setEntries(previous => Object.fromEntries(servers.flatMap(server => {
      const signature=JSON.stringify([server.url,server.deviceId,server.key]);
      const entry=previous[server.id];
      return entry?.signature === signature ? [[server.id,entry]]:[];
    })));
    const load = async (server: typeof servers[number]) => {
      const serial = (sequence.current.get(server.id) ?? 0)+1; sequence.current.set(server.id,serial);
      const signature = JSON.stringify([server.url,server.deviceId,server.key]);
      setEntries(previous => ({...previous,[server.id]:{signature,data:previous[server.id]?.signature === signature ? previous[server.id].data:null,error:null,loading:true}}));
      try {
        const data = parseDecisionHistory(await clientFor(server.id).decisions());
        if (active && sequence.current.get(server.id) === serial) setEntries(previous => ({...previous,[server.id]:{signature,data,error:null,loading:false}}));
      } catch (error) {
        if (active && sequence.current.get(server.id) === serial) setEntries(previous => ({...previous,[server.id]:{signature,data:error instanceof RelayError && ['device_revoked','key_unknown','unauthorized','pairing_required'].includes(error.code) ? null:previous[server.id]?.signature === signature ? previous[server.id].data:null,error,loading:false}}));
      }
    };
    const run = () => { const done = waiters.current.splice(0); void Promise.all(servers.map(load)).then(() => { for (const settle of done) settle(); }); };
    run(); const timer = setInterval(run,5000);
    return () => { active = false; clearInterval(timer); };
  },[servers,clientFor,attempt]);
  const results = servers.map(server => {
    const signature = JSON.stringify([server.url,server.deviceId,server.key]);
    const entry = entries[server.id]?.signature === signature ? entries[server.id] : undefined;
    return {server,...(entry ?? {data:null,error:null,loading:true})};
  });
  return { results, retry: () => setAttempt(value => value+1),
    /** Loads again and resolves once that load has settled, for pull to refresh. */
    reloaded: () => new Promise<void>(done => { waiters.current.push(done); setAttempt(value => value+1); }) };
}
