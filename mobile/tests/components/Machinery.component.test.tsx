import { useState, type ReactElement } from 'react';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { HoldKey, Lights, Needle, Odometer, Sweep, VoiceBox } from '@/ui/machinery';
import { emitAppBlur, emitAppFocus, emitAppState, emitReduceMotion, navigation } from '../support/native';
import { animatedStyle, animatedViews } from '../support/motion';
import { renderApp } from '../support/renderApp';

const frame = () => animatedViews().map(animatedStyle);
const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });
/** Fails unless, a frame later, the pieces keep changing at every 100 ms step of the fake clock. */
function expectMoving() {
  advance(50);
  for (let step = 0; step < 3; step++) {
    const before = JSON.stringify(frame());
    advance(100);
    expect(JSON.stringify(frame())).not.toBe(before);
  }
}
/** Fails unless, a frame later, the pieces stay exactly as they are for the next 5 s. */
function expectStill() {
  advance(50);
  const before = JSON.stringify(frame());
  advance(5000);
  expect(JSON.stringify(frame())).toBe(before);
}

// Each continuous piece and where «reducir movimiento» leaves it (S-15).
const pieces: [string, ReactElement, object[]][] = [
  ['foquitos', <Lights key="foquitos" tone="orange" />, Array.from({ length: 13 }, () => [{ opacity: 1, transform: [{ scale: 1 }] }, { opacity: 1 }]).flat()],
  ['barrido', <Sweep key="barrido" tone="red" />, [{ left: '38%' }]],
  ['caja de voz', <VoiceBox key="voz" />, Array.from({ length: 3 }, () => ({ transform: [{ scaleY: 0.5 }] }))],
  ['aguja viva', <Needle key="aguja" reading={{ angle: 10, red: false }} live />, [{ transform: [{ rotate: '10deg' }] }]],
];

test.each(pieces)('with «reducir movimiento» the %s rest in place with no animation running, and move again when it is off', async (_name, piece, rest) => {
  render(<ChatVisibilityProvider value>{piece}</ChatVisibilityProvider>);
  await act(async () => {});
  expectMoving();
  act(() => { emitReduceMotion(true); });
  advance(50);
  expect(frame()).toMatchObject(rest);
  expect(jest.getTimerCount()).toBe(0);
  expectStill();
  act(() => { emitReduceMotion(false); });
  expectMoving();
});

test('a piece mounted while «reducir movimiento» is on starts at rest', async () => {
  emitReduceMotion(true);
  render(<ChatVisibilityProvider value><Sweep tone="orange" /></ChatVisibilityProvider>);
  await act(async () => {});
  advance(50);
  expect(frame()).toMatchObject([{ left: '38%' }]);
  expect(jest.getTimerCount()).toBe(0);
});

test('the app in the background or without window focus stops the machinery, and returning starts it again', async () => {
  const app = renderApp(<LockGate><Lights tone="red" /><Sweep tone="red" /><VoiceBox /></LockGate>); await app.ready();
  expectMoving();
  await act(async () => { emitAppState('background'); });
  expectStill();
  await act(async () => { emitAppState('active'); });
  expectMoving();
  act(() => { emitAppBlur(); });
  expectStill();
  act(() => { emitAppFocus(); });
  expectMoving();
});

test('machinery on a screen that is not in front stays still', async () => {
  navigation.focused = false;
  render(<ChatVisibilityProvider value><Sweep tone="orange" /></ChatVisibilityProvider>);
  await act(async () => {});
  expectStill();
});

test('a digit that changes rolls up once from the old one, and motion coming back does not roll it again', async () => {
  let setValue: (value: string) => void = () => {};
  function Uptime() {
    const [value, set] = useState('12');
    setValue = set;
    return <Odometer value={value} />;
  }
  // How far each digit's column has risen: -24 shows the current digit, 0 the one before it.
  const rise = () => frame().map(style => (style.transform as { translateY: number }[])[0].translateY + 0);
  const app = renderApp(<LockGate><Uptime /></LockGate>); await app.ready();
  expect(rise()).toEqual([-24, -24]);
  act(() => { setValue('13'); });
  expect(rise()).toEqual([-24, 0]);
  advance(300);
  expect(rise()).toEqual([-24, -24]);
  await act(async () => { emitAppState('background'); });
  advance(50);
  await act(async () => { emitAppState('active'); });
  advance(50);
  expect(rise()).toEqual([-24, -24]);
});

describe('the key that is held', () => {
  const leds = () => frame().map(style => Number(Number(style.opacity).toFixed(2)));

  test('released before 1 s it empties its strip in 150 ms and never reports', () => {
    const complete = jest.fn();
    render(<HoldKey accessibilityLabel="Aprobar" onComplete={complete}><Text>Aprobar</Text></HoldKey>);
    const key = screen.getByRole('button', { name: 'Aprobar' });
    expect(leds()).toEqual([0, 0, 0, 0, 0, 0]);
    fireEvent(key, 'pressIn');
    advance(500);
    expect(leds()).toEqual([1, 1, 1, 0, 0, 0]);
    advance(450);
    fireEvent(key, 'pressOut');
    advance(150);
    expect(leds()).toEqual([0, 0, 0, 0, 0, 0]);
    advance(2000);
    expect(complete).not.toHaveBeenCalled();
  });

  test('held for 1 s it fills left to right and reports once', () => {
    const complete = jest.fn();
    render(<HoldKey accessibilityLabel="Aprobar" onComplete={complete}><Text>Aprobar</Text></HoldKey>);
    const key = screen.getByRole('button', { name: 'Aprobar' });
    fireEvent(key, 'pressIn');
    advance(999);
    expect(complete).not.toHaveBeenCalled();
    advance(1);
    expect(leds()).toEqual([1, 1, 1, 1, 1, 1]);
    expect(complete).toHaveBeenCalledTimes(1);
    advance(3000);
    fireEvent(key, 'pressOut');
    advance(150);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(leds()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('the Pausa general variant fills in steps of 50 ms and 5 %', () => {
    render(<HoldKey accessibilityLabel="Pausa general" stepped onComplete={() => {}}><Text>Pausa</Text></HoldKey>);
    fireEvent(screen.getByRole('button', { name: 'Pausa general' }), 'pressIn');
    advance(49);
    expect(leds()).toEqual([0, 0, 0, 0, 0, 0]);
    advance(71);
    expect(leds()).toEqual([0.6, 0, 0, 0, 0, 0]);
  });

  test('disabled in the middle of a hold, its strip empties in 150 ms and it never reports', () => {
    const complete = jest.fn();
    const { rerender } = render(<HoldKey accessibilityLabel="Aprobar" onComplete={complete}><Text>Aprobar</Text></HoldKey>);
    fireEvent(screen.getByRole('button', { name: 'Aprobar' }), 'pressIn');
    advance(700);
    expect(leds()).toEqual([1, 1, 1, 1, 0.2, 0]);
    rerender(<HoldKey accessibilityLabel="Aprobar" onComplete={complete} disabled><Text>Aprobar</Text></HoldKey>);
    advance(150);
    expect(leds()).toEqual([0, 0, 0, 0, 0, 0]);
    advance(2000);
    expect(complete).not.toHaveBeenCalled();
  });

  test('with a screen reader, activating it asks to confirm instead of holding, and only the confirmation reports', () => {
    const complete = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<HoldKey accessibilityLabel="Aprobar" onComplete={complete}><Text>Aprobar</Text></HoldKey>);
    const key = screen.getByRole('button', { name: 'Aprobar' });
    fireEvent(key, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = alert.mock.calls[0];
    expect(title).toBe('¿Aprobar?');
    expect(buttons?.map(button => button.text)).toEqual(['Cancelar', 'Confirmar']);
    expect(complete).not.toHaveBeenCalled();
    act(() => { buttons![0].onPress?.(); });
    expect(complete).not.toHaveBeenCalled();
    act(() => { buttons![1].onPress?.(); });
    expect(complete).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  test('with a screen reader, a disabled key asks nothing, and one disabled while asking does not report', () => {
    const complete = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { rerender } = render(<HoldKey accessibilityLabel="Aprobar" onComplete={complete} disabled><Text>Aprobar</Text></HoldKey>);
    fireEvent(screen.getByRole('button', { name: 'Aprobar' }), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(alert).not.toHaveBeenCalled();
    rerender(<HoldKey accessibilityLabel="Aprobar" onComplete={complete}><Text>Aprobar</Text></HoldKey>);
    fireEvent(screen.getByRole('button', { name: 'Aprobar' }), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    rerender(<HoldKey accessibilityLabel="Aprobar" onComplete={complete} disabled><Text>Aprobar</Text></HoldKey>);
    act(() => { alert.mock.calls[0][2]![1].onPress?.(); });
    expect(complete).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
