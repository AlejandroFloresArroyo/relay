import { usePalette } from '@/theme/ThemeProvider';
import { useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Svg, { Path, Rect } from 'react-native-svg';
import { parseMarkdown, type Inline, type MarkdownBlock } from '@/core/markdown';
import { F, type Palette } from '@/theme/tokens';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

const pre = Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as unknown as TextStyle) : null;

export function Markdown({ text, column }: { text: string; column: number }) {
  const { K } = usePalette();
  const [linkError, setLinkError] = useState(false);
  const openLink = async (url: string) => {
    setLinkError(false);
    try { await Linking.openURL(url); } catch { setLinkError(true); }
  };
  return <View style={{ paddingHorizontal: 6, paddingVertical: 2, gap: 9 }}>
    <Blocks blocks={parseMarkdown(text)} openLink={openLink} column={column} />
    {linkError ? <T accessibilityRole="alert" s={12} c={K.dangerText}>No se pudo abrir el enlace. Reintenta.</T> : null}
  </View>;
}

type OpenLink = (url: string) => Promise<void>;
function inline(nodes: Inline[], openLink: OpenLink, K: Palette['K'], bold = false, italic = false): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text': return <Text key={index} style={{ ...(bold ? { fontFamily: F.sans['700'] } : {}), ...(italic ? { fontStyle: 'italic' } : {}) }}>{node.text}</Text>;
      case 'code': return <M key={index} s={11.5} w={bold ? '600' : '400'} style={{ backgroundColor: K.block, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 5 }}>{node.text}</M>;
      case 'strong': return inline(node.children, openLink, K, true, italic);
      case 'emphasis': return inline(node.children, openLink, K, bold, true);
      case 'link': return node.url ? <Text key={index} accessibilityRole="link" onPress={() => void openLink(node.url!)} style={{ color: K.accentText, textDecorationLine: 'underline' }}>
        {inline(node.children, openLink, K, true, italic)}
      </Text> : <Text key={index}>{inline(node.children, openLink, K, bold, italic)}</Text>;
    }
  });
}

function Blocks({ blocks, openLink, column }: { blocks: MarkdownBlock[]; openLink: OpenLink; column: number }) {
  const { K } = usePalette();
  return <>{blocks.map((block, index) => {
    switch (block.kind) {
      case 'paragraph': return <T key={index} selectable s={14} lh={1.5}>{inline(block.children, openLink, K)}</T>;
      case 'heading': return <T key={index} selectable accessibilityRole="header" s={block.level <= 2 ? 18 : 15.5} w="700" lh={1.3} ls={-0.015} style={{ marginTop: index === 0 ? 0 : 6 }}>
        {inline(block.children, openLink, K, true)}
      </T>;
      case 'code': return <Code key={index} text={block.text} language={block.language} />;
      case 'quote': return <View key={index} style={{ borderRadius: 12, backgroundColor: K.field, paddingVertical: 9, paddingHorizontal: 12, gap: 6 }}>
        <Blocks blocks={block.blocks} openLink={openLink} column={Math.max(0, column - 24)} />
      </View>;
      case 'list': return <View key={index} style={{ gap: 4 }}>
        {block.items.map((item, itemIndex) => <View key={itemIndex} style={{ flexDirection: 'row', gap: 8 }}>
          {block.ordered ? <T selectable s={14} lh={1.5} style={{ minWidth: 18 }}>{block.start + itemIndex}.</T> : <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 5, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: K.ink }} />}
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}><Blocks blocks={item} openLink={openLink} column={Math.max(0, column - 26)} /></View>
        </View>)}
      </View>;
      case 'table': return <View key={index} style={{ backgroundColor: K.block, borderRadius: 12, overflow: 'hidden', boxShadow: K.shadowBlock }}>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            <View style={{ flexDirection: 'row', backgroundColor: K.field }}>
              {block.header.map((cell, cellIndex) => <M key={cellIndex} selectable accessibilityRole="header" s={9.5} w="500" c={K.inkSecondary} ls={0.06} style={{ width: Math.max(100, (column - 12) / block.header.length), paddingVertical: 6, paddingHorizontal: 10, textAlign: block.align[cellIndex], textTransform: 'uppercase' }}>{inline(cell, openLink, K)}</M>)}
            </View>
            {block.rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: K.line }}>
              {row.map((cell, cellIndex) => <T key={cellIndex} selectable s={12.5} style={{ width: Math.max(100, (column - 12) / block.header.length), paddingVertical: 6, paddingHorizontal: 10, textAlign: block.align[cellIndex] }}>{inline(cell, openLink, K)}</T>)}
            </View>)}
          </View>
        </ScrollView>
      </View>;
      case 'rule': return <View key={index} style={{ height: 1, backgroundColor: K.line, marginVertical: 4 }} />;
    }
  })}</>;
}

function Code({ text, language }: { text: string; language: string }) {
  const { K } = usePalette();
  const [copyState, setCopyState] = useState({ text, state: 'ready' as 'ready' | 'copying' | 'copied' | 'error' });
  const state = copyState.text === text ? copyState.state : 'ready';
  if (copyState.text !== text) setCopyState({ text, state: 'ready' });
  const copy = async () => {
    setCopyState({ text, state: 'copying' });
    try {
      const copied = await Clipboard.setStringAsync(text);
      setCopyState({ text, state: copied ? 'copied' : 'error' });
    } catch { setCopyState({ text, state: 'error' }); }
  };
  return <RecessedScreen radius={12} style={{ overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingLeft: 12, paddingRight: 6, borderBottomWidth: 1, borderBottomColor: K.screenLine }}>
      <M s={9.5} ls={0.06} c={K.onScreenLabel}>{language ? language.toUpperCase() : 'CÓDIGO'}</M>
      <Pressable accessibilityRole="button" accessibilityLabel={state === 'copied' ? 'COPIADO' : 'COPIAR'} accessibilityState={{ disabled: state === 'copying' }} disabled={state === 'copying'} onPress={() => void copy()} style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: K.screenLine, borderRadius: 7, paddingVertical: 6, paddingHorizontal: 9 }}>
        <Svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={K.onScreenBright} strokeWidth={2.4}><Rect x={8} y={8} width={12} height={12} rx={2} /><Path d="M16 4H4v12" /></Svg>
        <M s={9.5} c={K.onScreenBright}>{state === 'copied' ? 'COPIADO' : 'COPIAR'}</M>
      </Pressable>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingVertical: 9, paddingHorizontal: 12 }}>
      <M selectable s={10.5} lh={1.7} c={K.onScreenBright} style={pre}>{text}</M>
    </ScrollView>
    {state === 'error' ? <T accessibilityRole="alert" s={12} c={K.dangerTextOnScreen} style={{ paddingHorizontal: 12, paddingBottom: 9 }}>No se pudo copiar el código. Reintenta.</T> : null}
  </RecessedScreen>;
}
