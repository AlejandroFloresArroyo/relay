import { usePalette, useThemePreference } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { useState, type ReactNode } from 'react';
import { DEMO_THEME_NOTICES } from '@/core/demo';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { THEME_OPTIONS } from '@/core/theme';
import { NOTIFICATION_DEMO_STATES, NOTIFICATION_SETTINGS_DEMO_STATES } from '@/core/notificationDemo';
import { AUTO_LOCK_OPTIONS } from '@/core/settings';
import { DEMO, useApp } from '@/state/app';
import { goToTab } from '@/state/navigation';

import { HomeIndicator, StatusBarSpace, useBottomInset, useSheetBounds } from '@/ui/chrome';
import { RootHeader } from '@/ui/headers';
import { Keycap, Lamp, ListBlock, ListRow, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { RadioRow, SwitchRow } from '@/ui/settingRows';

const NOTICE_LABELS = { pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado', expired: 'Expirado', uncertain: 'Sin confirmar', unknown: 'Desconocido' } as const;
const NOTICE_SETTINGS_LABELS = { configured: 'Configurado', 'all-kinds': 'Todos los tipos', unconfigured: 'Sin configurar', 'permission-denied': 'Sin permiso', unavailable: 'Sin respuesta', revoked: 'Revocado', protocol: 'Actualizar Puente' } as const;

export function SettingsScreen() {
  const { K } = usePalette();
  const { servers, selectedServer, settings, setSetting, showAutoLockSheet, previewLock } = useApp();
  const theme = useThemePreference();
  const [themeNotice, setThemeNotice] = useState<string | null>(null);
  const themeError = theme.error ?? (DEMO ? themeNotice : null);
  const version = Constants.expoConfig?.version ?? '1.0';
  const current = servers.find(server => server.id === selectedServer);
  const section = (title: string, rows: ReactNode) => <View style={{ gap: 8 }}><SectionHeader title={title} /><ListBlock>{rows}</ListBlock></View>;

  return (
    <View style={{ flex: 1, backgroundColor: K.background }}>
      <StatusBarSpace />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16, gap: 16 }}>
        <RootHeader title="Ajustes" />

        {section('SERVIDOR', <ListRow title="Servidor predeterminado" description="La lista está en Servidores" value={current?.name} chevron onPress={() => goToTab('servers')} />)}

        <View style={{ gap: 8 }}>
          {section('APARIENCIA', THEME_OPTIONS.map(({ value, label, detail }) => (
            <RadioRow key={value} title={label} description={detail} checked={theme.preference === value} onPress={() => theme.setPreference(value)} />
          )))}
          {themeError ? <T accessibilityRole="alert" s={12} c={K.dangerText} style={{ paddingHorizontal: 16 }}>{themeError}</T> : null}
        </View>

        {section('SEGURIDAD', [
          <SwitchRow key="faceid" title="Desbloquear con huella" description="Al abrir la app" on={settings.faceid} onChange={next => setSetting('faceid', next)} />,
          // Approving always asks for a fingerprint, so this switch is not a setting.
          <SwitchRow key="approve" title="Confirmar aprobaciones" description="Con huella al aprobar" on readOnly />,
          <ListRow key="lock" title="Bloqueo automático" value={AUTO_LOCK_OPTIONS.find(({ ms }) => ms === settings.autoLockMs)?.label} chevron onPress={() => showAutoLockSheet(true)} />,
        ])}

        {section('MÁS', [
          <ListRow key="notices" title="Avisos" description="ntfy privado" chevron disabled={!selectedServer} onPress={() => router.push({ pathname: '/notifications/[server]', params: { server: selectedServer! } })} />,
          ...(DEMO ? [<ListRow key="widget" title="Widget" chevron onPress={() => router.push("/widget-preview")} />] : []),
          <ListRow key="about" title="Acerca de" description={`Relay ${version} · sin telemetría`} />,
        ])}

        {DEMO ? (
          <View style={{ gap: 8 }}>
            <SectionHeader title="DEMOSTRACIÓN" />
            <View style={{ marginHorizontal: 12, gap: 8 }}>
              <Keycap label="Ver maquinaria y luz" onPress={() => router.push('/machinery-preview')} />
              {NOTIFICATION_DEMO_STATES.map(state => <Keycap key={state} label={`Aviso · ${NOTICE_LABELS[state]}`} onPress={() => router.push({ pathname: '/notices/[server]/[notice]', params: { server: 'atlas', notice: state } })} />)}
              {NOTIFICATION_SETTINGS_DEMO_STATES.map(state => <Keycap key={state} label={`Ajustes de avisos · ${NOTICE_SETTINGS_LABELS[state]}`} onPress={() => router.push({ pathname: '/notifications/[server]', params: { server: 'atlas', state } })} />)}
              <Keycap label="Ver pantalla de bloqueo" onPress={() => previewLock('locked')} />
              <Keycap label="Ver aviso de bloqueo" onPress={() => previewLock('notice')} />
              {DEMO_THEME_NOTICES.map(notice => <Keycap key={notice.label} label={notice.label} onPress={() => setThemeNotice(notice.message)} />)}
              {themeNotice ? <Keycap label="Ocultar aviso del tema" onPress={() => setThemeNotice(null)} /> : null}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Selector from canvas 22b·3, above the tab bar like the approval sheet. */
export function AutoLockSheet() {
  const { K } = usePalette();
  const { settings, setSetting, autoLockSheet, showAutoLockSheet } = useApp();
  const bottom = useBottomInset(34);
  const bounds = useSheetBounds();
  if (!autoLockSheet) return null;
  return (
    <View style={{ position: 'absolute', inset: 0 }}>
      <Pressable accessibilityLabel="Cerrar selector" onPress={() => showAutoLockSheet(false)} style={{ position: 'absolute', inset: 0, backgroundColor: K.sheetBackdrop }} />
      <ScrollView role="dialog" accessibilityLabel="Bloqueo automático" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 10, paddingHorizontal: 16, paddingBottom: bottom, gap: 10 }} style={{ position: 'absolute', ...bounds, bottom: 0, backgroundColor: K.block, borderTopLeftRadius: 30, borderTopRightRadius: 30, boxShadow: `${K.shadowBlock}, 0px -10px 30px rgba(0,0,0,0.3)` }}>
        <View style={{ alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: K.field }} />
        <View style={{ gap: 3, paddingHorizontal: 4 }}>
          <M {...TYPE.label} c={K.inkTertiary}>BLOQUEO AUTOMÁTICO</M>
          <T s={13} c={K.inkSecondary}>Cuánto tiempo sin usar Relay antes de pedir la huella</T>
        </View>
        {AUTO_LOCK_OPTIONS.map(({ ms, label, detail }) => {
          const selected = settings.autoLockMs === ms;
          return (
            <Pressable key={ms} role="radio" aria-checked={selected} onPress={() => { setSetting('autoLockMs', ms); showAutoLockSheet(false); }} style={{ minHeight: 54, borderRadius: 15, backgroundColor: K.key, boxShadow: selected ? `0px 0px 0px 1.5px ${K.accent}, 0px 2px 6px rgba(242,154,26,0.2)` : K.shadowKey, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, boxShadow: `inset 0px 0px 0px 2px ${selected ? K.ink : K.ledOff}`, alignItems: 'center', justifyContent: 'center' }}>
                {selected ? <Lamp tone="orange" size={8} /> : null}
              </View>
              <M s={13} style={{ width: 64 }}>{label}</M>
              <T s={12.5} c={K.inkSecondary}>{detail}</T>
            </Pressable>
          );
        })}
        <T s={12} lh={1.45} c={K.inkSecondary} style={{ paddingTop: 2, paddingHorizontal: 4 }}>Aprobar un comando siempre pide huella, aunque Relay esté desbloqueado.</T>
        <HomeIndicator />
      </ScrollView>
    </View>
  );
}
