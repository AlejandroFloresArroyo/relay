import { usePalette } from '@/theme/ThemeProvider';
import type { ReactNode } from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { ChatBlock, Segment } from '@/core/transcript';

import { Lamp } from '@/ui/kit';
import { RecessedScreen, VoiceBox } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { ActivityCommand } from './ActivityPanel';
import { Markdown } from './Markdown';
import { ServerFileChip } from './useChatServerFiles';
import { splitFileNotes } from '../../../../protocol/chatFiles';

export interface ChatTranscriptProps {
  blocks: ChatBlock[]; column: number; onWaitingPress: () => void;
  /** The app clock (ms), for the needle of ACTIVIDAD. */
  now: number;
  /** On a tablet ACTIVIDAD leaves the thread for its fixed panel (T-1). */
  hideActivity?: boolean;
  /** The Agente is sending text now: a live Turno that waits for no Decisión. */
  writing?: boolean;
  renderUserAttachment?: (itemId: string) => ReactNode; renderAssistantFiles?: (itemId: string) => ReactNode; assistantText?: (itemId: string, original: string) => string;
}
export function ChatTranscript({ blocks, ...props }: ChatTranscriptProps) {
  // The voice box sits under the newest text only, while it is still arriving.
  return <>{blocks.map((block, i) => <BlockView key={block.id} block={block} {...props} writing={props.writing === true && i === blocks.length - 1} />)}</>;
}

// white-space: pre. On web a single-line Text collapses runs of spaces unless told otherwise.
const pre = Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as unknown as TextStyle) : null;
/** The VENCIDA chip's well inside a recessed screen (D-09), the same in both themes. */
// Fixed: the recessed screen is dark in both themes, so the chip on it does not follow the theme.
const CHIP_ON_SCREEN = '#0F0F0E';

function BlockView({ block, column, now, hideActivity, writing, onWaitingPress, renderUserAttachment, renderAssistantFiles, assistantText }: Omit<ChatTranscriptProps, 'blocks'> & { block: ChatBlock }) {
  const { K } = usePalette();
  const segColor = (s: Segment) => (s.tone === 'fail' ? K.dangerTextOnScreen : s.tone === 'ok' ? K.okTextOnScreen : s.tone === 'dim' ? K.onScreenLabel : K.onScreen);
  switch (block.kind) {
    case 'user': {
      // #114: the Servidor files a message names arrive as leading notes; they read as chips, never raw.
      const { paths, text } = splitFileNotes(block.text);
      if (!text && !paths.length && !renderUserAttachment?.(block.id)) return null;
      return (
        <View style={{ alignSelf: 'flex-end', alignItems: 'flex-end', gap: 5, maxWidth: column > 0 ? column * 0.8 + 28 : '88%' }}>
          {block.redirected ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Svg width={10} height={10} viewBox="0 0 24 24"><Path d="M4 7h10a6 6 0 0 1 0 12H9M8 3L4 7l4 4" fill="none" stroke={K.accentText} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" /></Svg>
            <M s={9.5} ls={0.06} c={K.accentText}>REDIRIGIDO</M>
          </View> : null}
          <View style={{
            backgroundColor: block.redirected ? K.block : K.ink,
            borderRadius: 20,
            paddingVertical: 12,
            paddingHorizontal: 16,
            ...(block.redirected ? { boxShadow: `${K.shadowBlock}, 0px 0px 0px 1.5px ${K.ink}` } : {}),
          }}>
            {renderUserAttachment?.(block.id)}
            {paths.length ? <View style={{ gap: 6, marginBottom: text ? 8 : 0 }}>{paths.map((path) => <ServerFileChip key={path} path={path} onInk={!block.redirected} />)}</View> : null}
            {text || !paths.length ? <T selectable s={15} lh={1.4} c={block.redirected ? K.ink : K.block}>
              {text}
            </T> : null}
          </View>
        </View>
      );
    }
    case 'text':
      return (<>
        <Markdown text={assistantText?.(block.id, block.text) ?? block.text} column={column} />
        {/* The voice box stands for «escribiendo» while the Agente's text arrives. */}
        {block.streaming && writing ? <View style={{ marginLeft: 2 }}><VoiceBox /></View> : null}
        {renderAssistantFiles?.(block.id)}
        {block.runtime && !block.streaming ? <M s={9.5} ls={0.02} c={K.inkTertiary}>RESPONDIÓ · {block.runtime.provider} / {block.runtime.model}</M> : null}
      </>);
    case 'activity':
      return hideActivity ? null : <ActivityCommand block={block} now={now} onWaitingPress={onWaitingPress} />;
    case 'terminal':
      return (
        <RecessedScreen radius={16} style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <M s={9.5} ls={0.08} c={K.onScreenLabel} numberOfLines={1} style={{ flexShrink: 1 }}>
              {block.cwd ? `TERMINAL · ${block.cwd}` : 'TERMINAL'}
            </M>
            {block.end === 'failed' ? <M s={9.5} ls={0.08} c={K.dangerTextOnScreen}>FALLÓ</M> : null}
            {block.end === 'expired' ? <View style={{ minHeight: 22, paddingHorizontal: 8, borderRadius: 8, backgroundColor: CHIP_ON_SCREEN, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Lamp tone="off" size={6} onScreen />
              <M s={9.5} w="600" ls={0.06} c={K.onScreen}>VENCIDA</M>
            </View> : null}
          </View>
          {block.lines.map((segs, i) => (
            <M key={i} s={11} lh={1.6} c={K.onScreen} numberOfLines={1} style={pre}>
              {segs.map((s, j) => <M key={j} s={11} lh={1.6} c={segColor(s)}>{s.text}</M>)}
            </M>
          ))}
          {block.end === 'expired' ? <T s={13} lh={1.35} c={K.onScreen}>La Aprobación venció sin Decisión. El comando no se ejecutó.</T> : null}
        </RecessedScreen>
      );
    case 'diff':
      return (
        <View style={{ backgroundColor: K.block, borderRadius: 16, boxShadow: K.shadowBlock }}>
          <View style={{ borderRadius: 16, overflow: 'hidden' }}>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: K.line }}>
              <M s={9.5} lh={1.75} c={K.inkTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>
                {block.file}
              </M>
              <M s={9.5} lh={1.75}>
                <M s={9.5} c={K.okText}>
                  +{block.added}
                </M>{' '}
                <M s={9.5} c={K.dangerText}>
                  −{block.removed}
                </M>
              </M>
            </View>
            {block.lines.map((l, i) => (
              <View
                key={i}
                style={{
                  paddingHorizontal: 12,
                  paddingBottom: i === block.lines.length - 1 ? 4 : 0,
                  backgroundColor: l.sign === '-' ? K.diffRemoved : K.diffAdded,
                }}>
                <M s={9.5} lh={1.75} c={l.sign === '-' ? K.dangerText : K.okText} numberOfLines={1} style={pre}>
                  {l.text}
                </M>
              </View>
            ))}
          </View>
        </View>
      );
  }
}
