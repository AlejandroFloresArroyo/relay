import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCommentsPage, KanbanItemDetail, KanbanItemsPage, KanbanItemMutationResult, KanbanNotifyReceipt, KanbanNotifyRequest } from '../../../protocol/kanban';
import { KANBAN_COLUMNS } from '../../../protocol/kanban';
import { RelayError, type RelayClient } from '@/core/client';
import { parseWorkCache, parseWorkPreferences, workCache, parseWorkAttempts, workAttempts, type WorkAttempt, type WorkPreferences } from '@/core/kanban';
import { workFailure } from '@/core/kanbanClient';
import { useApp } from './app';
import { useControlScope } from './useControlScope';
import { load, save, saveServers } from './storage';
const retiredClients = new WeakMap<RelayClient, ConnectionDiagnosis>();
const owners = new Map<string, { client: RelayClient; source: string }>();
const retirementListeners = new Set<(client: RelayClient) => void>();
const writes = new Map<string, Promise<void>>();
function store(key: string, text: string, strict=false, permitted: () => boolean = () => true) {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => { if (permitted()) return strict ? saveServers(key,text) : save(key,text); });
  writes.set(key,pending);
  void pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); }).catch(() => {});
  return pending;
}
const denied = (error: unknown) => error instanceof RelayError && ['device_revoked','unauthorized','key_unknown','pairing_required'].includes(error.code);
export function useWork(serverId: string) {
  const {ready,servers,clientFor,snapshot,refresh} = useApp();
  const server = servers.find(value => value.id === serverId);
  const source = server ? JSON.stringify([server.id,server.url,server.deviceId]) : '';
  const client = useMemo(() => clientFor(serverId),[clientFor,serverId]);
  const api = client.kanban;
  const snap = snapshot(serverId);
  const rejected = snap.down?.action === 'pair';
  const online = ready && !!server && snap.reachable === true && snap.protocol?.kind === 'compatible' && !snap.protocolStale && !rejected;
  const cacheKey = `relay.work.v1.${encodeURIComponent(serverId)}`;
  const attemptKey = `${cacheKey}.notices`;
  const prefKey = `${cacheKey}.preferences`;
  const [loadedClient,setLoadedClient] = useState<RelayClient | null>(null);
  const [page,setPage] = useState<KanbanItemsPage | null>(null);
  const [fresh,setFresh] = useState(false);
  const [loading,setLoading] = useState(true);
  const [diagnosis,setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [selected,setSelected] = useState<string | null>(null);
  const [detail,setDetail] = useState<KanbanItemDetail | null>(null);
  const [comments,setComments] = useState<KanbanCommentsPage | null>(null);
  const [preferences,setPreferences] = useState<WorkPreferences>({column:'todo',compact:false});
  const [preferencesReady,setPreferencesReady] = useState(false);
  const [reloadVersion,reload] = useState(0);
  const waiting = useRef<(() => void)[]>([]);
  const busyToken = useRef<object | null>(null);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState<KanbanNotifyReceipt | null>(null);
  const [attempts,setAttempts] = useState<Record<string,WorkAttempt>>({});
  const attemptsRef = useRef<Record<string,WorkAttempt>>({});
  const attempt = selected ? attempts[selected] ?? null : null;
  const [,invalidateRetirement] = useState(0);
  const authDenied = retiredClients.has(client);
  const owns = useCallback(() => owners.get(cacheKey)?.client === client && owners.get(cacheKey)?.source === source, [cacheKey, client, source]);
  const admitted = useCallback(() => owns() && !retiredClients.has(client), [owns, client]);
  const retire = useCallback((failure: unknown) => {
    if (!denied(failure)) return false;
    retiredClients.set(client, classifyConnectionError(failure));
    // Visibility retires a response; a terminal denial retires its client in every view.
    // Native writes already running finish before the guarded purge. A new client owns
    // its own data even when it reuses this Server's persistent cache keys.
    if (owns()) { void store(cacheKey, '', false, owns); void store(attemptKey, '', false, owns); }
    for (const listener of retirementListeners) listener(client);
    return true;
  }, [client, owns, cacheKey, attemptKey]);
  useLayoutEffect(() => {
    owners.set(cacheKey, { client, source });
    const onRetired = (retired: RelayClient) => {
      if (retired !== client) return;
      attemptsRef.current = {}; busyToken.current = null;
      setPage(null); setDetail(null); setComments(null); setSelected(null);
      setFresh(false); setLoading(false); setAttempts({}); setNotice(null); setBusy(false);
      setDiagnosis(retiredClients.get(client) ?? null); invalidateRetirement(value => value + 1);
    };
    retirementListeners.add(onRetired);
    return () => { retirementListeners.delete(onRetired); };
  }, [client, source, cacheKey]);
  const identity = useMemo(() => ({client,source,selected,revision:detail?.item.revision,pageRevision:page?.revision}),[client,source,selected,detail?.item.revision,page?.revision]);
  const scope = useControlScope(identity,online && !authDenied);
  useLayoutEffect(() => {
    let active = true;
    attemptsRef.current={};
    void (async () => {
      await Promise.resolve();if(!active)return;
      setLoadedClient(null);setPage(null);setDetail(null);setComments(null);setSelected(null);setFresh(false);setLoading(true);setError(null);setDiagnosis(null);setPreferencesReady(false);setAttempts({});
      if (!ready || !source) return;
      await writes.get(cacheKey);
      const cached = parseWorkCache(await load(cacheKey),source);
      const prefs = await load(prefKey);
      await writes.get(attemptKey)?.catch(() => {});
      const savedAttempts = parseWorkAttempts(await load(attemptKey),source);
      if (!active || !admitted()) return;
      setLoadedClient(client);setPage(cached);setPreferences(parseWorkPreferences(prefs));setPreferencesReady(true);setAttempts(savedAttempts);attemptsRef.current=savedAttempts;
      if (!online) setLoading(false);
    })();
    return () => { active = false; };
    // Client identity changes also retire credentials without placing them in storage keys.
  },[ready,source,client,cacheKey,prefKey,attemptKey,admitted]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!rejected && !authDenied) return;
    let active=true;attemptsRef.current={};
    void Promise.resolve().then(()=>{if(active){setPage(null);setDetail(null);setComments(null);setSelected(null);setFresh(false);setLoading(false);setAttempts({});}});
    void store(cacheKey,'',false,owns);void store(attemptKey,'',false,owns);
    return ()=>{active=false;};
  },[rejected,authDenied,cacheKey,attemptKey,client,source,owns]);
  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();if(!active)return;
      if (!scope.visible || !preferencesReady || loadedClient!==client || !api) { setFresh(false); if (!online) setLoading(false); return; }
      setLoading(true);setFresh(false);setError(null);setDiagnosis(null);
      try {
        let combined: KanbanItemsPage | null = null;
        const cursors = new Set<string>();
        for (let number = 0; number < 5; number++) {
          const next: KanbanItemsPage = await api.items({limit:100,...(combined?.nextCursor ? {cursor:combined.nextCursor} : {})});
          if (!active || !admitted()) return;
          if (combined && (combined.revision !== next.revision || KANBAN_COLUMNS.some(key => combined!.counts[key] !== next.counts[key]))) throw new RelayError('kanban_conflict','Trabajo cambió.');
          const previous = combined as KanbanItemsPage | null;
          combined = {...next,items:[...(previous?.items ?? []),...next.items]};
          if (new Set(combined.items.map(item => item.id)).size !== combined.items.length || combined.items.length > 500) throw new RelayError('kanban_store_unavailable','Trabajo no disponible.');
          if (!next.nextCursor) break;
          if (cursors.has(next.nextCursor)) throw new RelayError('kanban_store_unavailable','Trabajo no disponible.');
          cursors.add(next.nextCursor);
        }
        if (!combined || combined.nextCursor || KANBAN_COLUMNS.some(key => combined!.items.filter(item => item.column === key).length !== combined!.counts[key])) throw new RelayError('kanban_store_unavailable','Trabajo no disponible.');
        if (!active || !admitted()) return;
        setPage(combined);setFresh(true);setLoading(false);
        await store(cacheKey,workCache(source,combined),false,admitted);
      } catch (failure) {
        if (retire(failure) || !active || !admitted()) return;
        setDiagnosis(failure instanceof RelayError && ['device_revoked','unauthorized','key_unknown','pairing_required','unreachable','timeout','cleartext_blocked','tailnet_required','rate_limited'].includes(failure.code)?classifyConnectionError(failure):null);setError(workFailure(failure));setFresh(false);setLoading(false);
      }
    })().finally(() => { if (active) for (const done of waiting.current.splice(0)) done(); });
    return () => { active = false; };
  },[scope.visible,preferencesReady,loadedClient,client,api,online,source,cacheKey,attemptKey,reloadVersion,admitted,retire]);
  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();if(!active)return;
      setDetail(null);setComments(null);
      if (!selected || !fresh || !scope.visible || !api || loadedClient!==client) return;
      try {
        const data = await api.item(selected);
        if(!active || !admitted())return;
        let result = await api.comments(selected,{limit:100});
        if(!active || !admitted())return;
        if (result.nextCursor) {
          const next = await api.comments(selected,{limit:100,cursor:result.nextCursor});
          if (next.itemRevision !== result.itemRevision || next.nextCursor) throw new RelayError('kanban_conflict','Trabajo cambió.');
          result = {...next,comments:[...result.comments,...next.comments]};
        }
        if (data.item.revision !== result.itemRevision || result.comments.length !== data.item.commentCount || new Set(result.comments.map(value => value.id)).size !== result.comments.length) throw new RelayError('kanban_conflict','Trabajo cambió.');
        if (!active || !admitted()) return;
        setDetail(data);setComments(result);
      } catch (failure) { if (retire(failure)) return; if (active && admitted()) { setDiagnosis(failure instanceof RelayError && ['device_revoked','unauthorized','key_unknown','pairing_required','unreachable','timeout','cleartext_blocked','tailnet_required','rate_limited'].includes(failure.code)?classifyConnectionError(failure):null);setError(workFailure(failure));setFresh(false); } }
    })();
    return () => { active = false; };
  },[selected,fresh,scope.visible,api,reloadVersion,cacheKey,attemptKey,loadedClient,client,admitted,retire]);
  useLayoutEffect(() => {
    let active=true;busyToken.current=null;
    void Promise.resolve().then(()=>{if(active){setBusy(false);setNotice(null);}});
    return ()=>{active=false;};
  },[client,source,selected,scope.visible]);
  const owned = loadedClient===client;
  const writable = owned && fresh && online && !authDenied && scope.visible && !loading;
  async function operate<T>(action: () => Promise<T>, permission: (() => boolean) | null, apply: (result:T) => void): Promise<T | null> {
    const current = scope.begin();
    if (!api || !writable || busyToken.current || !current || !permission?.()) return null;
    const token = {};busyToken.current=token;setBusy(true);setError(null);setDiagnosis(null);
    try {
      const result = await action();
      if (!admitted() || !current() || !permission()) return null;
      apply(result);return result;
    } catch (failure) {
      if (retire(failure) || !admitted() || !current() || !permission()) return null;
      if(failure instanceof RelayError && failure.code==='kanban_conflict')setFresh(false);
      setDiagnosis(failure instanceof RelayError && ['device_revoked','unauthorized','key_unknown','pairing_required','unreachable','timeout','cleartext_blocked','tailnet_required','rate_limited'].includes(failure.code)?classifyConnectionError(failure):null);setError(workFailure(failure));return null;
    } finally { if (busyToken.current === token) {busyToken.current=null;setBusy(false);} }
  }
  const metadata = (action: () => Promise<KanbanItemMutationResult>, permission: (()=>boolean)|null) => operate(action,permission,result=>{
    setFresh(false);setDetail(null);setComments(null);setSelected(result.item.id);reload(n=>n+1);
  });
  const notify = (body:KanbanNotifyRequest, permission:(()=>boolean)|null) => {
    const target = detail?.item;
    if (!target || !api || attempt || !permission?.() || !writable || busyToken.current) return Promise.resolve(null);
    const next={...attemptsRef.current,[target.id]:{itemId:target.id,requestId:body.requestId,itemRevision:body.revision,agentId:body.agentId,requestedAt:Date.now()}};
    attemptsRef.current=next;setAttempts(next);
    return operate(async()=>{
      await store(attemptKey,workAttempts(source,next),true,admitted);
      if (!admitted() || !permission() || !scope.begin()?.()) throw new RelayError('cancelled','Aviso retirado.');
      return api.notify(target.id,body);
    },permission,acceptReceipt);
  };
  function acceptReceipt(receipt:KanbanNotifyReceipt) {
    setNotice(receipt);
    if (receipt.state==='rejected' || receipt.state==='started' && receipt.turn && ['completed','failed','cancelled'].includes(receipt.turn.phase)) {
      const next={...attemptsRef.current};delete next[receipt.itemId];attemptsRef.current=next;setAttempts(next);
      void store(attemptKey,workAttempts(source,next),false,admitted);
    }
  }
  const consult = () => {
    const target = attempt ?? (detail?.latestNotification ? {itemId:detail.item.id,requestId:detail.latestNotification.requestId} : null);
    const permission=scope.begin();
    if (!target || !api) return Promise.resolve(null);
    return operate(()=>api.receipt(target.itemId,target.requestId),permission,acceptReceipt);
  };
  const prefer = (value: WorkPreferences) => {setPreferences(value);void save(prefKey,JSON.stringify(value));};
  return {server,source,client,api,snap,page:!owned||rejected||authDenied?null:page,detail:!owned||rejected||authDenied||detail?.item.id!==selected?null:detail,comments:!owned||rejected||authDenied?null:comments,selected,select:setSelected,preferences,prefer,loading,error,diagnosis:retiredClients.get(client)??snap.down??diagnosis,scope,
    busy,metadata,notify,consult,attempt:owned&&!rejected&&!authDenied?attempt:null,notice:owned&&!rejected&&!authDenied?notice:null,
    fresh:owned && fresh && online && !authDenied, writable,
    reload:() => {reload(n => n + 1);refresh(serverId);},
    /** Reloads and resolves once that load has settled, for pull to refresh. */
    reloaded:() => new Promise<void>(done => {waiting.current.push(done);reload(n => n + 1);refresh(serverId);})};
}
