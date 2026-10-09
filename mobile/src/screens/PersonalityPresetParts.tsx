import { usePalette } from '@/theme/ThemeProvider';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import type { PersonalityPresetSummary } from '../../../protocol/personalityPresets';
import { TYPE } from '@/theme/tokens';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { HomeIndicator, useBottomInset } from '@/ui/chrome';
import { useChatVisible } from '@/state/chatVisibility';
export function PresetSheet({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
 const {K}=usePalette();
 const bottom=useBottomInset(18),{width}=useWindowDimensions(),shown=useChatVisible();
 // A native Modal outlives LockGate's hidden subtree: off while locked, back after unlock.
 return <Modal transparent visible={shown} animationType="none" onRequestClose={close} accessibilityViewIsModal>
  <View style={{flex:1,backgroundColor:K.sheetBackdrop,justifyContent:'flex-end',alignItems:'center'}}>
   <View style={{width:'100%',maxWidth:width>=840?620:540,maxHeight:'92%',borderTopLeftRadius:24,borderTopRightRadius:24,backgroundColor:K.block,boxShadow:K.shadowSheet,padding:16,paddingBottom:bottom,gap:14}}>
    <View style={{width:36,height:4,borderRadius:2,backgroundColor:K.ledOff,alignSelf:'center'}}/>
    <T {...TYPE.subtitle} ls={-0.015} c={K.ink} accessibilityRole="header">{title}</T>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{gap:12,paddingBottom:4}}>{children}</ScrollView>
    <Keycap label="Cerrar" onPress={close}/><HomeIndicator/>
   </View>
  </View>
 </Modal>;
}
/** A ListBlock inside a sheet: the sheet is already a block, so the rows sit in a recessed well, flush with the sheet's padding. */
export function sheetBlock(K:{field:string;shadowField:string}){return {marginHorizontal:0,backgroundColor:K.field,boxShadow:K.shadowField};}
/** A row of the catalogue: name and «SOUL DEL AGENTE · 49 BYTES»; chosen ones carry a lit LED. Draw it inside a ListBlock. */
export function PresetRow({preset,onPress,selected=false,disabled=false}:{preset:PersonalityPresetSummary;onPress:()=>void;selected?:boolean;disabled?:boolean}) {
 const {K}=usePalette();
 return <Pressable accessibilityRole="button" accessibilityLabel={preset.name} accessibilityState={{selected,disabled}} disabled={disabled} onPress={onPress} style={{minHeight:56,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:12,opacity:disabled?0.45:1}}>
  {selected?<Lamp tone="orange"/>:null}
  <View style={{flex:1,gap:2}}><T {...TYPE.body} c={K.ink}>{preset.name}</T><M s={9.5} ls={0.04} c={K.inkTertiary}>{preset.kind==='soul'?'SOUL DEL AGENTE':'CAPA DE CONVERSACIÓN'} · {preset.bytes} BYTES</M></View>
  <T s={18} c={K.inkTertiary}>›</T>
 </Pressable>;
}
export function PresetContent({title,content,revision}:{title:string;content:string;revision?:string}) {
 const {K}=usePalette();
 return <View style={{gap:7}}><T {...TYPE.body} c={K.ink}>{title}</T>{revision?<M s={9.5} c={K.inkTertiary} selectable>{`${title} · ${revision}`}</M>:null}<RecessedScreen radius={16} style={{padding:14,maxHeight:240}}><ScrollView nestedScrollEnabled><M s={12} c={K.onScreenBright} lh={1.6} selectable>{content||'Contenido vacío.'}</M></ScrollView></RecessedScreen></View>;
}
export function PresetProblem({message,reload}:{message:string;reload?:()=>void}) {
 const {K}=usePalette();
 return <View style={{borderRadius:20,backgroundColor:K.block,boxShadow:K.shadowBlock,padding:14,gap:10}}><T s={13} c={K.dangerText} lh={1.5} accessibilityLiveRegion="polite">{message}</T>{reload?<Keycap variant="link" label="Recargar" onPress={reload} style={{alignSelf:'flex-start'}}/>:null}</View>;
}
