import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import type { RemoteWebAccessList, RemoteWebApp } from '../../../../protocol/remoteWeb';
import { approvalDeadline } from '@/core/approvalTime';
import type { WebApi } from '@/core/remoteWeb';
import { useNow } from '@/state/app';
import { useChatVisible } from '@/state/chatVisibility';
import { RADIUS, type Palette } from '@/theme/tokens';
import { usePalette } from '@/theme/ThemeProvider';
import { Keycap, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';

/** The access page of a browser reloads every 2 s; the list follows it while this screen is shown. */
const POLL_MS = 2_000;
/** A card on the panel: a K block of radius 20. */
export const card = (K: Palette['K']) => ({ padding: 14, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }) as const;
const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';
const clock = (ms: number) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

interface Ended { id: string; code: string; how: 'cancelled' | 'expired' | 'ended' }
const ENDED: Record<Ended['how'], { label: string; detail: string }> = {
  cancelled: { label: 'CANCELADA', detail: 'La cancelaste desde Relay. El navegador ya no entra y lo que tenía abierto se cortó.' },
  expired: { label: 'VENCIDA', detail: 'Pasó su hora, contada con el reloj del Servidor. El navegador vuelve a pedir un código.' },
  ended: { label: 'TERMINADA', detail: 'El Puente la terminó: la aplicación se detuvo, se olvidó o el Puente se reinició.' },
};

/**
 * The external authorization of one app (#90): the phone's browser shows a code; Relay grants the
 * request with that code. It lasts one hour from the grant on the Server's clock, is never renewed,
 * survives locking Relay and the browser in front, and ends when cancelled here.
 */
export function WebAccess({ app, web, onBack }: { app: RemoteWebApp; web: WebApi; onBack: () => void }) {
  const { K } = usePalette();
  // `offset` turns the Server's times into the phone's, sampled when the list arrives.
  const [list, setList] = useState<{ body: RemoteWebAccessList; offset: number } | null>(null);
  const [ended, setEnded] = useState<Ended[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const known = useRef(new Map<string, { code: string; deadline: number }>());
  const cancelled = useRef(new Set<string>());
  const shown = useChatVisible();
  const now = useNow(1_000);

  const asked = useRef(0);
  const refresh = async () => {
    // Only the latest answer counts: a poll that comes back late never undoes a newer list.
    const mine = ++asked.current;
    try {
      const body = await web.access(app.id);
      if (mine !== asked.current) return;
      const offset = Date.now() - body.serverNow;
      // What this device granted and the Puente no longer lists ended: say how, it never just vanishes.
      const gone = [...known.current].filter(([id]) => !body.authorizations.some((each) => each.id === id)).map(([id, { code, deadline }]): Ended => (
        { id, code, how: cancelled.current.has(id) ? 'cancelled' : deadline <= Date.now() ? 'expired' : 'ended' }));
      known.current = new Map(body.authorizations.map((each) => [each.id, { code: each.code, deadline: approvalDeadline(each.expiresAt, offset)! }]));
      if (gone.length) setEnded((items) => [...gone, ...items.filter((item) => !gone.some((g) => g.id === item.id))].slice(0, 5));
      setList({ body, offset });
      setError(null);
    } catch (failed) {
      if (mine === asked.current) setError(failure(failed));
    }
  };
  const poll = useEffectEvent(() => void refresh());
  useEffect(() => {
    if (!shown) return;
    poll();
    const timer = setInterval(() => poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [shown]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try { await run(); await refresh(); } catch (failed) { setError(failure(failed)); } finally { setBusy(null); }
  };
  const requests = list?.body.requests.filter((each) => approvalDeadline(each.expiresAt, list.offset)! > now) ?? [];
  const granted = list?.body.authorizations ?? [];

  return (
    <View style={{ gap: 12, paddingBottom: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Keycap variant="link" accessibilityLabel="Volver a las aplicaciones" label="‹ Apps" onPress={onBack} />
        <View style={{ flex: 1 }}>
          <T s={16} w="700" c={K.ink} numberOfLines={1}>{app.name}</T>
          <M s={9.5} ls={0.57} c={K.inkTertiary}>EN EL NAVEGADOR DEL TELÉFONO</M>
        </View>
      </View>
      <View style={{ padding: 14, gap: 10, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
        <T s={13} c={K.inkSecondary} lh={1.45}>
          Ábrela en el navegador del teléfono: mostrará un código. Autoriza solo el código que ves en el navegador; quien muestre ese código entra durante una hora.
        </T>
        <Keycap variant="primary" accessibilityLabel="Abrir la aplicación en el navegador" label="Abrir en el navegador" disabled={!app.origin}
          onPress={() => { if (app.origin) Linking.openURL(`${app.origin}/`).catch(() => setError('El teléfono no pudo abrir el navegador.')); }} />
        {app.origin ? null : <T s={12.5} c={K.dangerText}>La aplicación aún no tiene su nombre publicado en el Servidor.</T>}
      </View>
      {error ? <T s={13} c={K.dangerText} lh={1.4}>{error}</T> : null}

      <SectionHeader title="CÓDIGOS PENDIENTES" />
      {list && !requests.length ? <T s={13} c={K.inkSecondary} lh={1.4}>Ningún navegador espera. Abre la aplicación en el navegador para ver su código.</T> : null}
      {requests.map((request) => (
        <View key={request.id} style={[card(K), { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <M s={20} ls={0.08} c={K.ink}>{request.code}</M>
            <M s={9.5} ls={0.57} c={K.inkTertiary}>CADUCA A LAS {clock(approvalDeadline(request.expiresAt, list!.offset)!)}</M>
          </View>
          <Keycap accessibilityLabel={`Autorizar código ${request.code}`} disabled={busy !== null} onPress={() => void act(request.id, () => web.grant(app.id, request))}
            label={busy === request.id ? 'Autorizando…' : 'Autorizar'} />
        </View>
      ))}

      <SectionHeader title="AUTORIZADAS DESDE ESTE TELÉFONO" />
      {list && !granted.length && !ended.length ? <T s={13} c={K.inkSecondary}>Ninguna.</T> : null}
      {granted.map((each) => {
        const deadline = approvalDeadline(each.expiresAt, list!.offset)!;
        const over = deadline <= now;
        return (
          <View key={each.id} style={[card(K), { gap: 8 }, over ? null : { boxShadow: `${K.shadowBlock}, ${K.shadowAccentRim}` }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <M s={16} ls={0.08} c={K.ink} style={{ flex: 1 }}>{each.code}</M>
              <M s={9.5} w="600" ls={0.57} c={over ? K.inkTertiary : K.accentText} accessibilityLiveRegion="polite">{over ? 'VENCIDA' : each.redeemed ? 'EN USO' : 'ESPERANDO AL NAVEGADOR'}</M>
            </View>
            <T s={12.5} c={K.inkSecondary}>{`Vence a las ${clock(deadline)}`}</T>
            {over ? null : (
              <Keycap variant="danger" accessibilityLabel={`Cancelar autorización ${each.code}`} disabled={busy !== null}
                onPress={() => { cancelled.current.add(each.id); void act(each.id, () => web.cancel(app.id, each.id)); }}
                label={busy === each.id ? 'Cancelando…' : 'Cancelar autorización'} />
            )}
          </View>
        );
      })}
      {ended.map((each) => (
        <View key={each.id} style={[card(K), { gap: 6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <M s={16} ls={0.08} c={K.inkTertiary} style={{ flex: 1 }}>{each.code}</M>
            <M s={9.5} w="600" ls={0.57} c={K.inkTertiary}>{ENDED[each.how].label}</M>
          </View>
          <T s={12.5} c={K.inkSecondary} lh={1.4}>{ENDED[each.how].detail}</T>
        </View>
      ))}

      <T s={12} c={K.inkTertiary} lh={1.45}>
        La hora cuenta desde que la concedes, con el reloj del Servidor, y no se renueva con el uso. Sigue aunque Relay se bloquee o el navegador quede en primer plano; termina al cancelarla, al revocar este teléfono, al olvidar la aplicación o al reiniciarse el Puente. Lo ya descargado no se borra.
      </T>
      <T s={12} c={K.inkTertiary} lh={1.45}>
        Cualquiera que llegue a esta dirección desde tu tailnet puede pedir acceso: hasta 20 solicitudes pendientes por aplicación, que caducan a los 5 minutos. Si ves códigos que no son tuyos, no los autorices.
      </T>
    </View>
  );
}
