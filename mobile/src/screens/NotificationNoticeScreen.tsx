import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useReturn } from '@/state/navigation';
import type { NotificationNotice } from '../../../protocol/notifications';
import { noticeCanDecide, notificationAuthorizationFailed, notificationError } from '@/core/notifications';
import { notificationNative } from '@/native/notifications';
import { useNotificationCache, useNotificationSession } from '@/state/notifications';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { useNow } from '@/state/app';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader, RootHeader } from '@/ui/headers';
import { Keycap } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

function retireNotice(serverId: string, noticeId: string) {
  try { notificationNative?.clearNotice(serverId,noticeId); return true; }
  catch { return false; }
}

export function NotificationNoticeScreen({ serverId, noticeId }: { serverId: string; noticeId: string }) {
  const { K } = usePalette();
  const session = useNotificationSession(serverId, noticeId);
  const cache = useNotificationCache();
  const running = useRef(false);
  const [sample, setSample] = useState<{notice:NotificationNotice;at:number} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const now = useNow(1000);
  const ret = useReturn();
  const fail = useCallback((failure: unknown, current: () => boolean, retire: () => boolean, posted = false) => {
    const present = current();
    if (notificationAuthorizationFailed(failure) && retire()) {
      // Retire this captured client before any pending preference write can resume.
      setSample(null); setResult(null);
      if (present) setError(notificationError(failure));
    } else if (current()) {
      setError(notificationError(failure));
      // Only a failed decision POST may have reached the Puente; a failed read keeps the notification.
      if (posted) { setResult('Decisión sin confirmar'); retireNotice(serverId,noticeId); }
    }
  }, [serverId, noticeId]);
  useEffect(() => {
    void Promise.resolve().then(() => { setSample(null); setResult(null); if (!session.blocked) setError(null); });
    if (!session.visible || !session.client) return;
    const current = session.capture(); const retire = session.captureRetirement();
    void session.client.notice(noticeId).then(notice => { if (current()) { setSample({notice,at:Date.now()}); if (notice.state !== 'pending' && !retireNotice(serverId,noticeId)) setError(notice.state === 'approved' || notice.state === 'rejected' ? 'El aviso de Android no se retiró. La Decisión confirmada se conserva.' : 'El aviso de Android no se retiró.'); } }, failure => { fail(failure,current,retire); });
  }, [session, serverId, cache, noticeId, fail]);
  async function decide(choice: 'once' | 'deny') {
    if (running.current || !sample || !session.client) return;
    const current = session.capture(); const retire = session.captureRetirement();
    if (!current() || !noticeCanDecide(sample.notice, sample.at, Date.now())) return;
    running.current = true; setBusy(true); setError(null); let posted = false;
    try {
      if (choice === 'once' && !await confirmWithFingerprint('Aprobar comando con huella')) { if (current()) setError('No se confirmó la huella.'); return; }
      if (!current()) return;
      const fresh = await session.client.notice(noticeId); const received = Date.now();
      if (!current()) return;
      if (fresh.registrationId !== sample.notice.registrationId || JSON.stringify(fresh.target) !== JSON.stringify(sample.notice.target) || fresh.approval.command !== sample.notice.approval.command || !fresh.approval.choices.includes(choice) || !noticeCanDecide(fresh, received, Date.now())) {
        setSample({notice:fresh,at:received}); setError('El comando cambió o expiró. Revísalo antes de decidir.'); return;
      }
      // Last visibility/scope check follows the fresh read, immediately before sending.
      if (!current()) return;
      posted = true;
      const ack = await session.client.decide(noticeId, {schema:1,registrationId:fresh.registrationId,target:fresh.target,choice});
      if (current()) { setResult(ack.outcome === 'approved' ? 'Aprobado' : 'Rechazado'); if (!retireNotice(serverId,noticeId)) setError('El aviso de Android no se retiró. La Decisión confirmada se conserva.'); }
    } catch (failure) { fail(failure,current,retire,posted); }
    finally { running.current = false; setBusy(false); }
  }
  const notice = sample?.notice;
  const pending = sample && noticeCanDecide(sample.notice, sample.at, now) && session.visible && !result;
  const expiry = notice?.expiresAt === null ? 'Sin vencimiento' : sample ? `${Math.max(0,Math.ceil(((notice?.expiresAt ?? 0) - sample.notice.serverNow - now + sample.at)/1000))} s restantes` : '';
  const subtitle = `AVISO · ${(session.server?.name ?? 'SERVIDOR NO EMPAREJADO').toUpperCase()}`;
  const gutter = { paddingHorizontal: 16 } as const;
  return <View accessibilityLabel="Aprobación desde aviso" style={{flex:1,backgroundColor:K.background}}><StatusBarSpace/><ScrollView contentContainerStyle={{paddingBottom:16,gap:12,maxWidth:640,width:'100%',alignSelf:'center'}}>
    {ret ? <DetailHeader back={ret.label} onBack={ret.go} title="Aprobación" subtitle={subtitle} /> : <View style={gutter}><RootHeader title="Aprobación"/><M s={9.5} ls={0.04} c={K.inkTertiary}>{subtitle}</M></View>}
    {session.visible && notice ? <>
      <T {...TYPE.block} c={K.ink} style={gutter}>{notice.approval.agentName}</T>
      <RecessedScreen radius={RADIUS.field} style={{marginHorizontal:12,padding:16}}><M s={12} c={K.onScreenBright}>{notice.approval.command}</M></RecessedScreen>
      <M s={9.5} ls={0.04} c={K.inkTertiary} style={gutter}>{expiry}</M>
      {notice.approval.risk ? <T {...TYPE.secondary} c={K.inkSecondary} style={gutter}>Riesgo {notice.approval.risk.level} · {notice.approval.risk.label}</T> : null}
      <T {...TYPE.secondary} c={K.inkSecondary} style={gutter}>Aprobar requiere una huella nueva. Revisar el aviso no envía una Decisión.</T>
      {result ? <T {...TYPE.body} c={K.ink} style={gutter}>{result}</T> : !pending ? <T {...TYPE.body} c={K.ink} style={gutter}>{notice.state === 'pending' ? 'Expirado o lectura vencida' : ({approved:'Aprobado',rejected:'Rechazado',expired:'Expirado',uncertain:'Decisión sin confirmar',unknown:'Aviso desconocido'})[notice.state]}</T> : <View style={{marginHorizontal:12,gap:12}}>
        <Keycap variant="primary" label="Aprobar con huella" disabled={busy || !notice.approval.choices.includes('once')} onPress={()=>{void decide('once');}} />
        <Keycap label="Rechazar" disabled={busy || !notice.approval.choices.includes('deny')} onPress={()=>{void decide('deny');}} />
      </View>}
    </> : <T {...TYPE.secondary} c={K.inkSecondary} style={gutter}>{session.diagnosis?.hint ?? (session.blocked ? 'Empareja este teléfono para revisar el aviso.' : 'Consultando el aviso…')}</T>}
    {error ? <View style={{marginHorizontal:12,padding:12,borderRadius:RADIUS.keyLarge,backgroundColor:K.block,boxShadow:K.shadowBlock}}><T {...TYPE.secondary} c={K.dangerText}>{error}</T></View> : null}
  </ScrollView></View>;
}
