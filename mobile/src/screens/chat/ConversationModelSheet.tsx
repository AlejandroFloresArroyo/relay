import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import Svg, { Circle, Path } from 'react-native-svg';

import type { Conversation, ModelOptions, ModelSelection } from '../../../../protocol/protocol';
import { filterModelOptions } from '@/core/modelOptions';
import { RelayError, type RelayClient } from '@/core/client';
import { F } from '@/theme/tokens';
import { HomeIndicator, useBottomInset } from '@/ui/chrome';
import { Keycap } from '@/ui/kit';
import { M, T } from '@/ui/primitives';

interface Props {
  client: RelayClient;
  agentId: string;
  contextKey: string;
  conversation: Conversation;
  busy: boolean;
  onApplied: (conversation: Conversation) => void;
  onClose: () => void;
  demoControl?: ReactNode;
}

function sameModel(a: ModelSelection | null, b: ModelSelection | null) {
  return a?.provider === b?.provider && a?.model === b?.model;
}

/** Canvas 09·6. Idle selection saves immediately, as decided for #38. */
export function ConversationModelSheet(props: Props) {
  const [identity, setIdentity] = useState({ client: props.client, revision: 0 });
  if (identity.client !== props.client) setIdentity({ client: props.client, revision: identity.revision + 1 });
  return <ModelSheet key={`${identity.revision}:${props.contextKey}:${props.agentId}:${props.conversation.id}`} {...props} />;
}

function ModelSheet({ client, agentId, conversation, busy, onApplied, onClose, demoControl }: Props) {
  const { K } = usePalette();
  const bottom = useBottomInset(34);
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ModelSelection | null | undefined>(undefined);
  const mounted = useRef(true);
  const pending = useRef(false);
  const context = useRef({ client, conversation });
  useEffect(() => { context.current = { client, conversation }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const writable = conversation.origin === 'relay' && conversation.writable && conversation.state === 'ready';

  useEffect(() => {
    let current = true;
    client.models(agentId).then((result) => {
      if (current) { setOptions(result); setLoading(false); }
    }, () => {
      if (current) { setError('NO SE PUDIERON CARGAR LOS MODELOS'); setLoading(false); }
    });
    return () => { current = false; };
  }, [client, agentId, retry]);

  const save = async (model: ModelSelection | null) => {
    if (!options || pending.current || !writable || sameModel(model, conversation.model ?? options.defaultModel)) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      const latest = context.current;
      if (!mounted.current || latest.client !== client || latest.conversation.id !== conversation.id || !latest.conversation.writable || latest.conversation.origin !== 'relay' || latest.conversation.state !== 'ready') return;
      const updated = await client.setConversationModel(agentId, conversation.id, { model });
      if (mounted.current && context.current.client === client) onApplied(updated);
    } catch (failure) {
      if (mounted.current && context.current.client === client) setError(failure instanceof RelayError ? failure.message : 'NO SE PUDO CAMBIAR EL MODELO');
    } finally {
      pending.current = false;
      if (mounted.current && context.current.client === client) setSaving(false);
    }
  };

  const select = (model: ModelSelection | null) => {
    if (pending.current || !writable) return;
    if (busy) setConfirmation(model);
    else void save(model);
  };

  const effective = conversation.model ?? options?.defaultModel ?? null;
  const providers = [...new Set(options?.models.map((model) => model.provider) ?? [])];
  const visibleModels = filterModelOptions(options?.models ?? [], query, providerFilter);
  const visibleProviders = [...new Set(visibleModels.map((model) => model.provider))];
  const filteringDisabled = saving || confirmation !== undefined;
  const disabled = filteringDisabled || !writable;
  return <View style={{ position: 'absolute', inset: 0 }} accessibilityViewIsModal>
    <Pressable accessibilityLabel="Cerrar modelos" disabled={saving} onPress={onClose}
      style={{ position: 'absolute', inset: 0, backgroundColor: K.sheetBackdrop }} />
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '90%', backgroundColor: K.block,
      borderTopLeftRadius: 30, borderTopRightRadius: 30, boxShadow: K.shadowSheet, paddingTop: 10, paddingHorizontal: 16, paddingBottom: bottom, gap: 8 }}>
      <View style={{ alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: K.field }} />
      <M s={9.5} ls={0.08} c={K.inkTertiary} style={{ paddingHorizontal: 4 }}>MODELO DE ESTA CONVERSACIÓN</M>
      <T s={12.5} lh={1.45} c={K.inkSecondary} style={{ paddingHorizontal: 4, paddingBottom: 4 }}>
        Solo cambia esta conversación. El modelo por defecto del Agente se cambia en el Servidor.
      </T>
      {options && options.models.length > 0 ? <View style={{ gap: 8 }}>
        <View style={{ minHeight: 48, borderRadius: 13, backgroundColor: K.field, boxShadow: K.shadowField, paddingLeft: 12, paddingRight: query ? 0 : 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Svg width={15} height={15} viewBox="0 0 24 24"><Circle cx={11} cy={11} r={6.5} stroke={K.inkTertiary} strokeWidth={2} fill="none" /><Path d="M20 20l-4-4" stroke={K.inkTertiary} strokeWidth={2} /></Svg>
          <TextInput accessibilityLabel="Buscar modelo" placeholder="Buscar modelo" placeholderTextColor={K.inkTertiary} value={query} onChangeText={setQuery}
            editable={!filteringDisabled} autoCapitalize="none" autoCorrect={false} returnKeyType="search" maxLength={256}
            style={{ flex: 1, minWidth: 0, fontFamily: F.sans['400'], fontSize: 14, color: K.ink, paddingVertical: 0 }} />
          {query ? <Pressable accessibilityRole="button" accessibilityLabel="Limpiar búsqueda" disabled={filteringDisabled} onPress={() => setQuery('')}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M6 6l12 12M18 6L6 18" stroke={K.inkSecondary} strokeWidth={2} strokeLinecap="round" /></Svg>
          </Pressable> : null}
        </View>
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 4 }}>
          {[null, ...providers].map((provider) => <Pressable key={provider ?? '@all'} accessibilityRole="button"
            accessibilityLabel={provider === null ? 'Todos los proveedores' : `Filtrar por ${provider}`} accessibilityState={{ selected: providerFilter === provider }}
            disabled={filteringDisabled} onPress={() => setProviderFilter(provider)}
            style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: 13, justifyContent: 'center', backgroundColor: providerFilter === provider ? K.ink : K.block, boxShadow: providerFilter === provider ? undefined : K.shadowKey }}>
            <M s={9.5} ls={0.04} c={providerFilter === provider ? K.onInk : K.inkSecondary}>{provider ?? 'Todos'}</M>
          </Pressable>)}
        </ScrollView>
      </View> : null}
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 6 }}>
        {loading ? <M s={9.5} c={K.inkTertiary}>CARGANDO MODELOS…</M> : null}
        {visibleProviders.map((provider) => <View key={provider} style={{ gap: 8 }}>
          <M s={9.5} ls={0.08} c={K.inkTertiary} style={{ paddingHorizontal: 6 }}>{provider === 'ollama' ? 'LOCAL · OLLAMA' : provider.toUpperCase()}</M>
          {visibleModels.filter((model) => model.provider === provider).map((model) => {
            const selected = sameModel(effective, model);
            return <Pressable key={model.model} role="radio" aria-checked={selected} accessibilityLabel={`${provider} · ${model.label}`}
              disabled={disabled || selected} onPress={() => select({ provider: model.provider, model: model.model })}
              style={{ minHeight: 46, borderRadius: 14, backgroundColor: selected ? K.key : K.block,
                boxShadow: selected ? `0px 0px 0px 1.5px ${K.accent}` : K.shadowKey,
                flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: selected ? K.ink : K.ledOff, alignItems: 'center', justifyContent: 'center' }}>
                {selected ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: K.accent }} /> : null}
              </View>
              <M s={12} style={{ flex: 1 }}>{model.label}</M>
              {selected ? <M s={9.5} c={K.accentText}>EN USO</M> : null}
            </Pressable>;
          })}
        </View>)}
        {!loading && options && options.models.length > 0 && visibleModels.length === 0 ? <T s={12.5} lh={1.45} c={K.inkSecondary} accessibilityLiveRegion="polite" style={{ padding: 6 }}>No hay modelos que coincidan. Cambia la búsqueda o el proveedor.</T> : null}
        {!loading && options?.models.length === 0 ? <M s={9.5} c={K.inkTertiary}>NO HAY MODELOS DISPONIBLES</M> : null}
        {!loading && conversation.model && options?.models.length ? <Pressable role="button" accessibilityLabel="Usar modelo por defecto del Agente" disabled={disabled} onPress={() => select(null)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
          <M s={9.5} c={K.accentText}>USAR MODELO POR DEFECTO DEL AGENTE</M>
        </Pressable> : null}
      </ScrollView>
      {confirmation !== undefined ? <View style={{ gap: 8, paddingTop: 4 }}>
        <T s={12.5} lh={1.45} c={K.inkSecondary}>Este Turno sigue con su modelo actual. El cambio se usará en el siguiente Turno.</T>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Keycap label="Cancelar cambio" disabled={saving} onPress={() => setConfirmation(undefined)} style={{ flex: 1 }} />
          <Keycap variant="primary" label="Cambiar modelo" disabled={saving} onPress={() => { void save(confirmation); }} style={{ flex: 1.3 }} />
        </View>
      </View> : null}
      {!writable ? <M s={9.5} c={K.inkTertiary}>CONVERSACIÓN DE SOLO LECTURA</M> : null}
      {saving ? <M s={9.5} c={K.inkTertiary}>CAMBIANDO MODELO…</M> : null}
      {error ? <M s={9.5} c={K.dangerText}>{error}</M> : null}
      {error && !options ? <Keycap label="Reintentar" onPress={() => { setLoading(true); setError(null); setRetry((value) => value + 1); }} /> : null}
      <Keycap label="Cancelar" onPress={onClose} disabled={saving} style={{ marginTop: 4 }} />
      {demoControl}
      <HomeIndicator />
    </View>
  </View>;
}
