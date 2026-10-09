import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { appendDictation, DICTATION_LOCALE, DICTATION_TAIL_MS, hasDictationModel, updateDictationText, type DictationText } from '@/core/dictation';
import { createDemoSpeech, type DemoDictationScenario } from '@/core/demoDictation';

export type DictationPhase = 'idle' | 'checking' | 'listening' | 'finishing' | 'model-missing' | 'permission-missing' | 'error' | 'blocked';
interface Session {
  live: boolean; held: boolean; started: boolean; ended: boolean; delivered: boolean;
  text: DictationText; tail?: ReturnType<typeof setTimeout>; fallback?: ReturnType<typeof setTimeout>;
  subscriptions: { remove(): void }[];
}
// Native events carry no request id. Do not admit another session until native end retires
// the previous recognizer, including across screen/context changes.
let nativeOwner: Session | null = null;
const remove = (session: Session) => { for (const subscription of session.subscriptions) subscription.remove(); session.subscriptions = []; };
const retire = (session: Session) => {
  remove(session); if (nativeOwner === session) nativeOwner = null;
};
function abortSession(port: { abort(): void }, session: Session) {
  if (session.ended) { retire(session); return; }
  try { port.abort(); } catch { /* Native ownership stays blocked until end. */ }
  if (!session.ended) {
    for (const subscription of session.subscriptions.slice(0, -1)) subscription.remove();
    session.subscriptions = session.subscriptions.slice(-1);
    session.fallback = setTimeout(() => remove(session), DICTATION_TAIL_MS);
  }
}
export function useDictation({ scope, disabled, draft, onDraft, demoScenario }: {
  scope: string; disabled: boolean; draft: string; onDraft: (draft: string) => void; demoScenario?: DemoDictationScenario;
}) {
  const [state, setState] = useState({ phase: (demoScenario === 'blocked' ? 'blocked' : 'idle') as DictationPhase, text: '', startedAt: null as number | null });
  const active = useRef<Session | null>(null);
  const port = useRef(demoScenario ? createDemoSpeech(demoScenario) : ExpoSpeechRecognitionModule).current;
  const destination = useRef({ draft, onDraft });
  useLayoutEffect(() => { destination.current = { draft, onDraft }; });
  const complete = (session: Session) => {
    if (!session.live || session.delivered || active.current !== session) return;
    session.delivered = true; session.live = false; active.current = null;
    clearTimeout(session.tail); clearTimeout(session.fallback);
    destination.current.onDraft(appendDictation(destination.current.draft, session.text));
    session.text = { phrases: [], partial: '' }; setState({ phase: 'idle', text: '', startedAt: null });
    if (session.ended) retire(session);
  };
  const cancel = useCallback(() => {
    const session = active.current;
    active.current = null;
    if (!session) return;
    session.live = false; session.held = false; session.text = { phrases: [], partial: '' }; clearTimeout(session.tail); clearTimeout(session.fallback);
    setState({ phase: 'idle', text: '', startedAt: null });
    if (session.started) abortSession(port, session);
    else retire(session);
  }, [port]);
  useLayoutEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => { if (next !== 'active') cancel(); });
    return () => { subscription.remove(); cancel(); };
  }, [scope, cancel]);
  useLayoutEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);
  async function begin() {
    if (disabled || active.current || AppState.currentState !== 'active') return;
    if (nativeOwner) { setState({ phase: 'blocked', text: '', startedAt: null }); return; }
    const session: Session = { live: true, held: true, started: false, ended: false, delivered: false, text: { phrases: [], partial: '' }, subscriptions: [] };
    active.current = session; nativeOwner = session; setState({ phase: 'checking', text: '', startedAt: null });
    const current = () => session.live && session.held && active.current === session && AppState.currentState === 'active';
    const fail = (phase: DictationPhase) => {
      if (!session.live || active.current !== session) return;
      session.live = false; session.text = { phrases: [], partial: '' }; active.current = null; clearTimeout(session.tail); clearTimeout(session.fallback);
      setState({ phase, text: '', startedAt: null });
      if (session.started) abortSession(port, session);
      else retire(session);
    };
    try {
      if (!port.supportsOnDeviceRecognition()) { fail('model-missing'); return; }
      const models = await port.getSupportedLocales({});
      if (!current()) return;
      if (!hasDictationModel(models.installedLocales)) { fail('model-missing'); return; }
      let permission = await port.getPermissionsAsync();
      if (!current()) return;
      if (!permission.granted && permission.canAskAgain) permission = await port.requestPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) { fail('permission-missing'); return; }
      session.subscriptions = [
        port.addListener('result', (event) => {
          if (!session.live || active.current !== session) return;
          const transcript = event.results[0]?.transcript;
          if (!transcript) return;
          session.text = updateDictationText(session.text, transcript, event.isFinal);
          setState((previous) => ({ ...previous, text: appendDictation('', session.text) }));
        }),
        port.addListener('error', (event) => {
          if (!session.live || active.current !== session) return;
          if (event.error === 'no-speech' || event.error === 'speech-timeout') {
            session.held = false; complete(session); abortSession(port, session);
          } else fail(event.error === 'not-allowed' ? 'permission-missing' : 'error');
        }),
        port.addListener('end', () => {
          session.ended = true; clearTimeout(session.fallback);
          // Native end is ordered after the last result. An early engine end still only
          // deposits a draft and never sends it, even if the finger remains held.
          if (session.live) complete(session);
          retire(session);
        }),
      ];
      session.started = true;
      setState({ phase: 'listening', text: '', startedAt: Date.now() });
      port.start({ lang: DICTATION_LOCALE, requiresOnDeviceRecognition: true, continuous: true, interimResults: true, recordingOptions: { persist: false } });
    } catch { fail('error'); }
  }
  function release() {
    const session = active.current;
    if (!session || !session.held) return;
    session.held = false;
    if (!session.started) { cancel(); return; }
    setState((previous) => ({ ...previous, phase: 'finishing' }));
    session.tail = setTimeout(() => {
      if (!session.live || active.current !== session) return;
      try { port.stop(); } catch { complete(session); abortSession(port, session); }
      if (!session.ended && session.live) session.fallback = setTimeout(() => {
        complete(session);
        abortSession(port, session);
      }, 250);
    }, DICTATION_TAIL_MS);
  }
  return { ...state, listening: ['checking', 'listening', 'finishing'].includes(state.phase), isListening: () => active.current !== null, begin, release, cancel };
}
