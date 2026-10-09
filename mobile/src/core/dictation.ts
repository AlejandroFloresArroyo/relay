export const DICTATION_LOCALE = 'es-US';
export const DICTATION_TAIL_MS = 1000;
export interface DictationText { phrases: string[]; partial: string }
export function hasDictationModel(installedLocales: readonly string[]): boolean {
  return installedLocales.some((locale) => locale.replaceAll('_', '-').toLowerCase() === DICTATION_LOCALE.toLowerCase());
}
export function updateDictationText(text: DictationText, transcript: string, isFinal: boolean): DictationText {
  const phrase = transcript.trim();
  if (!phrase) return text;
  return isFinal ? { phrases: [...text.phrases, phrase], partial: '' } : { ...text, partial: phrase };
}
export function appendDictation(draft: string, text: DictationText): string {
  const recognized = [...text.phrases, text.partial].filter(Boolean).join(' ');
  return recognized ? [draft.trimEnd(), recognized].filter(Boolean).join(' ') : draft;
}
