import { usePalette } from '@/theme/ThemeProvider';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { ServerUsage, UsageAmount, UsagePeriod } from '../../../protocol/serverUsage';
import { estimatedCost, usageDay, usageRange, usageStamp, usageTokens, USAGE_LABELS, USAGE_PERIODS } from '@/core/serverUsage';
import { DEMO, useApp } from '@/state/app';
import { goToTab, useReturn } from '@/state/navigation';
import { DEMO_USAGE_SCENARIOS, demoUsageScenario, setDemoUsage } from '@/core/demo';
import { useServerUsage } from '@/state/serverUsage';
import { TEXT_GLOW, TYPE } from '@/theme/tokens';
import { ConnectionStatus } from '@/ui/ConnectionStatus';

import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader, RootHeader } from '@/ui/headers';
import { Keycap, ListBlock, SectionHeader, Segmented } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

const READING_GLOW = TEXT_GLOW.accent;

/** The estimate of an amount: Mono 20 with the orange glow on a recessed screen (`bright`), plain ink on a block. */
function Cost({ amount, known, bright = false }: {amount:UsageAmount;known:UsageAmount;bright?:boolean}) {
  const { K } = usePalette();
  const partial = amount.estimatedCostUsd === null && known.estimatedCostUsd !== null;
  const note = bright ? K.onScreen : K.inkTertiary;
  return <View style={{gap:3}}>
    <M numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.65} {...TYPE.reading} s={bright?20:13} c={bright?K.accent:K.ink} glow={bright?READING_GLOW:false}>{estimatedCost(partial?known.estimatedCostUsd:amount.estimatedCostUsd)}</M>
    {partial ? <T s={11} c={note}>Estimación parcial</T> : amount.estimatedCostUsd===null ? <T s={11} c={note}>No informa costo</T> : null}
  </View>;
}
function Chart({report}:{report:ServerUsage}) {
  const { K } = usePalette();
  const tokens = report.totalsKnown.estimatedCostUsd === null;
  const field = tokens ? 'tokens' : 'estimatedCostUsd';
  const max = Math.max(...report.daily.map(d=>d.totalsKnown[field]??0),0)||1;
  const [day,setDay] = useState<string|null>(null);
  const selected = report.daily.find(d=>d.day===day);
  return <RecessedScreen radius={20} style={{marginHorizontal:12,padding:16,gap:10}}>
    <M {...TYPE.label} c={K.onScreenLabel}>{tokens?'TOKENS':'COSTO'} POR DÍA · {USAGE_LABELS[report.period].toUpperCase()}</M>
    <View style={{height:64,flexDirection:'row',alignItems:'flex-end',gap:6}}>
      {report.daily.map((d,i)=>{
        const value=d.totalsKnown[field]; const partial=d.amount[field]===null; const last=i===report.daily.length-1;
        const label=`${d.day}: ${tokens?usageTokens(value)+' tokens':estimatedCost(value)}${partial?' · parcial':''}`;
        return <Pressable key={d.day} accessibilityRole="button" accessibilityLabel={label} onPress={()=>setDay(d.day)} style={{flex:1,height:'100%',justifyContent:'flex-end',minWidth:3}}>
          <View style={{height:value===null?2:Math.max(value/max*56,2),backgroundColor:value===null?K.ledOff:last?K.accent:K.ok,opacity:value===null?1:partial?.45:last?.8:.7,borderRadius:4}} />
        </Pressable>;
      })}
    </View>
    <View style={{flexDirection:'row',justifyContent:'space-between'}}><M s={9.5} c={K.onScreenLabel}>{report.daily[0]&&usageDay(report.daily[0].day)}</M><M s={9.5} c={K.onScreenLabel}>{report.daily.length>1&&usageDay(report.daily[report.daily.length-1].day)}</M></View>
    {selected?<T s={13} c={K.onScreen}>{selected.day} · {tokens?`${usageTokens(selected.totalsKnown.tokens)} tokens`:estimatedCost(selected.totalsKnown.estimatedCostUsd)}{selected.amount[field]===null?' · parcial':''}</T>:null}
  </RecessedScreen>;
}
function Breakdown({report,models}:{report:ServerUsage;models:boolean}) {
  const { K } = usePalette();
  const rows = models ? report.models.map(m=>({id:m.model??'unknown',label:m.model??'Modelo no disponible',amount:m.amount,known:m.totalsKnown,status:'ok'})) : report.agents.map(a=>({id:a.id,label:a.name,amount:a.amount,known:a.totalsKnown,status:a.status}));
  const max = Math.max(...rows.map(r=>r.known.estimatedCostUsd??0),0)||1;
  return <View style={{gap:8}}>
    <SectionHeader title={`POR ${models?'MODELO':'AGENTE'} · ${USAGE_LABELS[report.period].toUpperCase()}`}/>
    <ListBlock>
      {rows.length===0?<T {...TYPE.secondary} c={K.inkTertiary} style={{paddingVertical:14}}>No hay modelos registrados en este período.</T>:rows.map(row=><View key={row.id} style={{paddingVertical:13,gap:8}}>
        <View style={{flexDirection:'row',alignItems:'flex-start',gap:12}}>
          <View style={{flex:1,gap:4}}><T {...TYPE.body} c={K.ink}>{row.label}</T><M s={9.5} ls={.04} c={K.inkTertiary}>{usageTokens(row.amount.tokens ?? row.known.tokens)} TOKENS{row.amount.tokens===null&&row.known.tokens!==null?' · PARCIAL':''}</M></View>
          <Cost amount={row.amount} known={row.known}/>
        </View>
        {row.status!=='ok'?<T {...TYPE.secondary} c={K.dangerText}>{row.label} · {row.status==='error'?'error de lectura':'no disponible'}</T>:null}
        <View style={{height:5,backgroundColor:K.field,borderRadius:3,overflow:'hidden'}}><View style={{height:5,width:`${(row.known.estimatedCostUsd??0)/max*100}%`,backgroundColor:K.accent,borderRadius:3}}/></View>
      </View>)}
    </ListBlock>
  </View>;
}
export function UsageScreen({serverId}:{serverId:string}) {
  const { K } = usePalette();
  const {servers,refresh} = useApp();
  const {reports,diagnosis,reload} = useServerUsage(serverId);
  const [period,setPeriod] = useState<UsagePeriod>('week');
  const [models,setModels] = useState(false);
  const [scenario,setScenario] = useState(()=>demoUsageScenario(serverId));
  const selected=reports[period];
  const demoLoading=DEMO&&scenario==='loading';
  const report=demoLoading?null:selected.data;
  const stale=selected.stale&&!!report;
  const retry=()=>{refresh(serverId);reload();};
  const ret=useReturn();
  const serverName=servers.find(s=>s.id===serverId)?.name;
  const subtitle=report&&report.daily.length>0?`${usageRange(report.daily[0].day,report.daily[report.daily.length-1].day)} · ${selected.loading?'ACTUALIZANDO…':'CÁLCULO GUARDADO'} ${usageStamp(report.capturedAt,report.timezone)} (HORA DE ${(serverName??'Servidor').toUpperCase()})`:undefined;
  const estimate=<View style={{minHeight:28,paddingHorizontal:10,borderRadius:8,backgroundColor:K.field,justifyContent:'center'}}><M s={9.5} w="600" ls={.06} c={K.accentText}>≈ ESTIMADO</M></View>;
  return <View style={{flex:1,backgroundColor:K.background}}>
    <StatusBarSpace/>
    <ScrollView contentContainerStyle={{paddingBottom:24,gap:12}}>
      {ret?<DetailHeader back={ret.label} onBack={ret.go} right={estimate} title="Uso y costo" subtitle={subtitle}/>:<><RootHeader title="Uso y costo" right={estimate}/>{subtitle?<M s={9.5} ls={.04} c={K.inkTertiary} style={{paddingHorizontal:16}}>{subtitle}</M>:null}</>}
      {DEMO?<View style={{paddingHorizontal:16}}><Keycap variant="link" label={`Demostración: ${DEMO_USAGE_SCENARIOS.find(s=>s.id===scenario)?.name} · Cambiar`} onPress={()=>{
        const next=DEMO_USAGE_SCENARIOS[(DEMO_USAGE_SCENARIOS.findIndex(s=>s.id===scenario)+1)%DEMO_USAGE_SCENARIOS.length];
        setScenario(next.id); setDemoUsage(serverId,next.id); reload();
      }} style={{alignSelf:'flex-start'}}/></View>:null}
      {diagnosis ? <View style={{marginHorizontal:12}}><ConnectionStatus serverName={serverName ?? 'el Servidor'} diagnosis={diagnosis} onRetry={retry}
        onPair={() => router.push({ pathname: '/connect', params: { serverId } })} /></View> : null}
      {stale?<T {...TYPE.secondary} w="600" c={K.inkTertiary} style={{paddingHorizontal:16}}>Último cálculo · solo lectura</T>:null}
      <View style={{marginHorizontal:12}}><Segmented options={USAGE_PERIODS.map(p=>USAGE_LABELS[p])} value={USAGE_LABELS[period]} onChange={label=>setPeriod(USAGE_PERIODS.find(p=>USAGE_LABELS[p]===label)??'week')}/></View>
      {!report && (selected.loading||demoLoading)?<View accessibilityLabel="Calculando uso…" style={{gap:12}}><M {...TYPE.label} c={K.inkTertiary} style={{paddingHorizontal:16}}>SUMANDO USO DEL SERVIDOR…</M><RecessedScreen radius={20} style={{marginHorizontal:12,height:140}}/><RecessedScreen radius={20} style={{marginHorizontal:12,height:110}}/></View>:!report?<T s={15} c={K.inkTertiary} style={{paddingHorizontal:16}}>Sin un cálculo guardado para este período.</T>:<>
        {report.partial?<RecessedScreen radius={20} rim style={{marginHorizontal:12,padding:20,gap:8}}><M s={13} w="600" ls={.08} c={K.accent} glow={READING_GLOW}>DATOS PARCIALES</M><T s={15} lh={1.45} c={K.onScreen}>La suma conocida excluye a los Agentes que no se pudieron leer. No es el total del Servidor.</T><T {...TYPE.secondary} c={K.onScreen}>No incluidos: {report.agents.filter(a=>a.status!=='ok').map(a=>`${a.name} (${a.status==='error'?'error de lectura':'no disponible'})`).join(', ')}.</T></RecessedScreen>:null}
        {report.total.conversations===0?<RecessedScreen radius={20} style={{marginHorizontal:12,padding:24,gap:12}}><M s={13} w="600" ls={.08} c={K.onScreenBright}>SIN USO REGISTRADO</M><T s={15} lh={1.45} c={K.onScreen}>No hay Conversaciones iniciadas en este período. Aquí aparecerán los tokens y el costo estimado que Hermes registre.</T><Keycap variant="screen" label="Abrir un chat" onPress={()=>goToTab('agents')} style={{alignSelf:'flex-start'}}/></RecessedScreen>:<View style={{opacity:stale?.65:1,gap:12}}>
          <RecessedScreen rim radius={20} style={{marginHorizontal:12,padding:16,gap:12}}>
            <View style={{flexDirection:'row',gap:10}}>{USAGE_PERIODS.map(p=>{
              const data=reports[p].data;
              return <View key={p} style={{flex:1,gap:5}}><M {...TYPE.label} c={K.onScreenLabel}>{USAGE_LABELS[p].toUpperCase()}</M>{data?<><Cost amount={data.total} known={data.totalsKnown} bright/><M s={9.5} c={K.onScreen}>{usageTokens(data.total.tokens??data.totalsKnown.tokens)} TOK</M>{data.total.tokens===null&&data.totalsKnown.tokens!==null?<T s={11} c={K.onScreen}>Tokens parciales</T>:null}{reports[p].stale?<T s={11} c={K.onScreen}>Guardado · {usageStamp(data.capturedAt,data.timezone)}</T>:null}</>:<M s={18} c={K.onScreenLabel}>{reports[p].loading?'…':'—'}</M>}</View>;
            })}</View>
            <T {...TYPE.secondary} c={K.onScreen}>Estimaciones parciales registradas por Hermes, en USD. Tu factura puede no coincidir. «—» significa no disponible.</T>
          </RecessedScreen>
          <Chart key={period} report={report}/>
          <ListBlock><View style={{flexDirection:'row',gap:12,paddingVertical:14}}>{([['ENTRADA','inputTokens'],['SALIDA','outputTokens'],['CACHÉ LEÍDA','cacheReadTokens']] as const).map(([label,key])=><View key={key} style={{flex:1,gap:4}}><M {...TYPE.label} c={K.inkTertiary}>{label}</M><M {...TYPE.reading} c={K.ink}>{usageTokens(report.total[key])}</M></View>)}</View></ListBlock>
          <T {...TYPE.secondary} c={K.inkTertiary} style={{paddingHorizontal:16}}>Total: entrada + salida. Caché leída por separado; no se suma otra vez.</T>
          <View style={{marginHorizontal:12}}><Segmented options={['Por Agente','Por modelo'] as const} value={models?'Por modelo':'Por Agente'} onChange={label=>setModels(label==='Por modelo')}/></View>
          <Breakdown report={report} models={models}/>
        </View>}
        <ListBlock><View style={{paddingVertical:14,gap:6}}><T {...TYPE.body} c={K.ink}>Por inicio de Conversación</T><T {...TYPE.secondary} c={K.inkSecondary}>Los totales acumulados se atribuyen al día en que empezó cada Conversación; no representan el consumo exacto de ese día. Semana desde el lunes y mes desde el día 1, según el calendario del Servidor. Modelo registrado por Conversación; no reconstruye cambios de modelo. No incluye uso auxiliar.</T></View></ListBlock>
      </>}
    </ScrollView>
  </View>;
}
