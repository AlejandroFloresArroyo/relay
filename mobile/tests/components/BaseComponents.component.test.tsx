import { useState } from 'react';
import { StyleSheet, Text, type ViewStyle } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { DetailHeader, RootHeader, ServerSwitch, TailnetPill, ToolHeader } from '@/ui/headers';
import { BackLink, IconKey, Keycap, Plate, Segmented } from '@/ui/kit';
import { PullToRefresh, SwipeRow } from '@/ui/gestures';
import { Sheet, Toast } from '@/ui/sheet';
import { StateRow, SubjectStateBlock, type StateSpec } from '@/ui/states';
import { drag, hold } from '../support/gestures';
import { resizeWindow } from '../support/native';
import { animatedStyle } from '../support/motion';

const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });
const shifted = (testID: string, axis: 'translateX' | 'translateY') =>
  ((animatedStyle(screen.getByTestId(testID)).transform ?? []) as unknown as Record<string, number>[]).find(step => axis in step)?.[axis] ?? 0;

describe('the sheet', () => {
  function Host({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return <Sheet visible={open} title="Red privada" subtitle="TAILSCALE · TAILNET-7F2C" onClose={() => { onClose(); setOpen(false); }}>
      <Text>contenido</Text>
    </Sheet>;
  }

  test('dragged 110 px by its grip it comes back; at 111 px it closes', () => {
    const onClose = jest.fn();
    render(<ChatVisibilityProvider value={true}><Host onClose={onClose} /></ChatVisibilityProvider>);
    advance(400);
    expect(shifted('sheet', 'translateY')).toBe(0);
    const grip = hold('sheet-grip', [{ y: 60 }, { y: 110 }]);
    advance(16);
    expect(shifted('sheet', 'translateY')).toBe(110);
    grip.release();
    advance(400);
    expect(onClose).not.toHaveBeenCalled();
    expect(shifted('sheet', 'translateY')).toBe(0);
    expect(screen.getByText('Red privada')).toBeVisible();

    drag('sheet-grip', [{ y: 111 }]);
    advance(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    advance(400);
    expect(screen.queryByText('Red privada')).toBeNull();
  });
});

describe('the swipe row', () => {
  test('calls its action at 90 px and not at 89, then springs back', () => {
    const open = jest.fn();
    render(<SwipeRow swipeRight={{ label: 'Abrir chat', onAction: open }}><Text>dev</Text></SwipeRow>);
    drag('swipe-row', [{ x: 40 }, { x: 89 }]);
    advance(320);
    expect(open).not.toHaveBeenCalled();
    expect(shifted('swipe-row', 'translateX')).toBe(0);
    drag('swipe-row', [{ x: 90 }]);
    advance(320);
    expect(open).toHaveBeenCalledTimes(1);
    expect(shifted('swipe-row', 'translateX')).toBe(0);
  });

  test('a direction without an action does not move and does nothing', () => {
    const pause = jest.fn();
    render(<SwipeRow swipeRight={{ label: 'Pausar', onAction: pause }}><Text>Tarea</Text></SwipeRow>);
    const left = hold('swipe-row', [{ x: -150 }]);
    advance(16);
    expect(shifted('swipe-row', 'translateX')).toBe(0);
    left.release();
    advance(320);
    expect(pause).not.toHaveBeenCalled();
    const right = hold('swipe-row', [{ x: 60 }]);
    advance(16);
    expect(shifted('swipe-row', 'translateX')).toBe(60);
    right.release();
    advance(320);
    expect(pause).not.toHaveBeenCalled();
    expect(shifted('swipe-row', 'translateX')).toBe(0);
  });
});

describe('pull to refresh', () => {
  test('from 60 px (120 px of finger at ×0.5) it says SUELTA PARA RECARGAR and reloads on release; 59 px does not', async () => {
    let finish = () => {};
    const onRefresh = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    // Visible on a screen in front, so the LED may blink.
    render(<ChatVisibilityProvider value><PullToRefresh onRefresh={onRefresh}><Text>lista</Text></PullToRefresh></ChatVisibilityProvider>);

    const short = hold('pull-to-refresh', [{ y: 60 }, { y: 118 }]);
    advance(16);
    expect(shifted('pull-content', 'translateY')).toBe(59);
    expect(screen.queryByText('SUELTA PARA RECARGAR')).toBeNull();
    short.release();
    advance(300);
    expect(onRefresh).not.toHaveBeenCalled();

    const enough = hold('pull-to-refresh', [{ y: 120 }]);
    advance(0);
    expect(screen.getByText('SUELTA PARA RECARGAR')).toBeVisible();
    enough.release();
    advance(0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText('CARGANDO…')).toBeVisible();
    // The orange LED blinks on a 1 s cycle: lit for the first half, at .25 for the second.
    const led = () => animatedStyle(screen.getByTestId('pull-led')).opacity;
    advance(100);
    expect(led()).toBe(1);
    advance(500);
    expect(led()).toBe(0.25);
    advance(500);
    expect(led()).toBe(1);

    await act(async () => { finish(); });
    advance(300);
    expect(screen.queryByText('CARGANDO…')).toBeNull();
  });

  test('started 100 px down the list, a 200 px drag scrolls to the top and does not reload', async () => {
    const onRefresh = jest.fn(async () => {});
    render(<PullToRefresh onRefresh={onRefresh}><Text>lista</Text></PullToRefresh>);
    const scroll = (y: number) => fireEvent.scroll(screen.getByText('lista'), { nativeEvent: { contentOffset: { x: 0, y } } });
    scroll(100);
    const finger = hold('pull-to-refresh', [{ y: 50 }]);
    scroll(50);
    finger.move([{ y: 100 }]);
    scroll(0);
    finger.move([{ y: 150 }, { y: 200 }]);
    advance(16);
    expect(screen.queryByText('SUELTA PARA RECARGAR')).toBeNull();
    finger.release();
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(shifted('pull-content', 'translateY')).toBe(0);
  });

  test('the pull stops at 96 px', async () => {
    render(<PullToRefresh onRefresh={async () => {}}><Text>lista</Text></PullToRefresh>);
    const far = hold('pull-to-refresh', [{ y: 400 }]);
    advance(16);
    expect(shifted('pull-content', 'translateY')).toBe(96);
    far.release();
    await act(async () => { jest.advanceTimersByTime(0); });
    advance(300);
  });
});

test('every plaquita is 32 wide, so row titles start at the same x whatever the label', () => {
  render(<><Plate label="LLM" /><Plate label="TOOL" /></>);
  const plates = screen.getAllByTestId('plate');
  expect(plates).toHaveLength(2);
  for (const plate of plates) expect(plate).toHaveStyle({ width: 32 });
});

test('at 130 % system font the plaquita grows with it and its label is not cut', () => {
  render(<Plate label="TOOL" />);
  expect(screen.getByTestId('plate')).toHaveStyle({ width: 32 });
  act(() => resizeWindow(390, 844, 1.3));
  expect(screen.getByTestId('plate')).toHaveStyle({ width: 42 });
  expect(screen.getByText('TOOL').props.numberOfLines).toBeUndefined();
});

test('the toast leaves at 2 s', () => {
  function Host() {
    const [message, setMessage] = useState<string | null>('Comando copiado');
    return message ? <Toast message={message} onHide={() => setMessage(null)} /> : null;
  }
  render(<Host />);
  advance(1999);
  expect(screen.getByText('Comando copiado')).toBeVisible();
  advance(1);
  expect(screen.queryByText('Comando copiado')).toBeNull();
});

describe('states', () => {
  const retry = jest.fn();
  const act1 = jest.fn();
  const cases: [string, StateSpec, string[], string | null][] = [
    ['cargando', { kind: 'loading', what: 'tablero' }, ['CARGANDO TABLERO…'], null],
    ['vacío', { kind: 'empty', title: 'SIN SERVIDORES', phrase: 'Empareja el primero con relayd pair.', action: { label: 'Agregar Servidor', onPress: act1 } },
      ['SIN SERVIDORES', 'Empareja el primero con relayd pair.'], 'Agregar Servidor'],
    ['error', { kind: 'error', verb: 'cargar el Tablero', onRetry: retry }, ['ERROR', 'No se pudo cargar el Tablero. Reintenta.'], 'Reintentar'],
    ['sin respuesta', { kind: 'unreachable', phrase: 'atlas no contesta; no se pudo leer SOUL.md.', onRetry: retry },
      ['SIN RESPUESTA · REVISA TAILNET', 'atlas no contesta; no se pudo leer SOUL.md.'], 'Reintentar'],
    ['sin control', { kind: 'noControl', phrase: 'Ahora no hay control sobre atlas. Tus terminales siguen ahí.', action: { label: 'Volver a entrar con huella', onPress: act1 } },
      ['SIN CONTROL', 'Ahora no hay control sobre atlas. Tus terminales siguen ahí.'], 'Volver a entrar con huella'],
    ['no disponible', { kind: 'unavailable', phrase: 'El Puente de atlas no ofrece Trabajo.' }, ['NO DISPONIBLE · ACTUALIZA EL PUENTE', 'El Puente de atlas no ofrece Trabajo.'], null],
    ['no disponible, por otra causa', { kind: 'unavailable', title: 'MÓDULO APK NO DISPONIBLE', phrase: 'Necesitas Android 12 o posterior.' },
      ['MÓDULO APK NO DISPONIBLE', 'Necesitas Android 12 o posterior.'], null],
    ['sin acceso', { kind: 'noAccess', phrase: 'Este dispositivo perdió el acceso a atlas.', action: { label: 'Emparejar de nuevo', onPress: act1 } },
      ['SIN ACCESO', 'Este dispositivo perdió el acceso a atlas.'], 'Emparejar de nuevo'],
  ];

  test('a state cannot name its own retry: «Reintentar» only comes through onRetry', () => {
    // @ts-expect-error «Volver a intentar» is not one of the D-ES ways out.
    const invented: StateSpec = { kind: 'noAccess', phrase: 'Sin acceso.', action: { label: 'Volver a intentar', onPress: retry } };
    expect(invented.kind).toBe('noAccess');
  });

  test.each(cases)('the block for «%s» is found by its text and its single action by its role', (_name, spec, texts, action) => {
    retry.mockClear(); act1.mockClear();
    render(<SubjectStateBlock spec={spec} />);
    for (const text of texts) expect(screen.getByText(text)).toBeVisible();
    const buttons = screen.queryAllByRole('button');
    expect(buttons).toHaveLength(action ? 1 : 0);
    if (!action) return;
    fireEvent.press(screen.getByRole('button', { name: action }));
    expect(retry.mock.calls.length + act1.mock.calls.length).toBe(1);
  });

  test('the compact row says «<SERVIDOR> · SIN RESPUESTA» with «Reintentar»', () => {
    render(<StateRow name="homelab" kind="unreachable" onRetry={retry} />);
    expect(screen.getByText('HOMELAB · SIN RESPUESTA')).toBeVisible();
    retry.mockClear();
    fireEvent.press(screen.getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('the compact group heads the Servidor with its state and dims each row beside «Reintentar»', () => {
    render(<StateRow name="homelab" kind="unreachable" onRetry={retry} rows={['ops']} />);
    expect(screen.getByText('HOMELAB')).toBeVisible();
    expect(screen.getByText('SIN RESPUESTA')).toBeVisible();
    expect(screen.getByText('ops')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });
});

describe('keys and returns', () => {
  /** The touch zone: the declared size plus its hit slop. Widths that come from text are measured by layout, not here. */
  function touchZone(button: ReactTestInstance) {
    const style = StyleSheet.flatten(button.props.style) as ViewStyle;
    const raw = button.props.hitSlop as number | { top?: number; bottom?: number; left?: number; right?: number } | undefined;
    const slop = typeof raw === 'number' ? { top: raw, bottom: raw, left: raw, right: raw } : raw ?? {};
    const size = (min: unknown, fixed: unknown) => Math.max(Number(min ?? 0), Number(fixed ?? 0));
    return {
      height: size(style.minHeight, style.height) + (slop.top ?? 0) + (slop.bottom ?? 0),
      width: size(style.minWidth, style.width) + (slop.left ?? 0) + (slop.right ?? 0),
    };
  }

  test('every key, return, pill and segment is a button with a touch zone of at least 48', () => {
    const press = () => {};
    render(<>
      <RootHeader title="Agentes" right={<><TailnetPill led="green" onPress={press} /><ServerSwitch name="atlas" led="green" onPress={press} /><IconKey glyph="+" round accessibilityLabel="Agregar" onPress={press} /><IconKey glyph="⋯" accessibilityLabel="Más" onPress={press} /></>} />
      <DetailHeader back="dev" onBack={press} title="Personalidad" />
      <ToolHeader back="Agentes" onBack={press} server="atlas" />
      <BackLink to="Servidores" onPress={press} />
      {(['normal', 'primary', 'dark', 'danger', 'link'] as const).map(variant => <Keycap key={variant} variant={variant} label={variant} onPress={press} />)}
      <Keycap label="Iniciar" disabled onPress={press} />
      <Segmented options={['Hoy', 'Semana', 'Mes']} value="Semana" onChange={press} />
    </>);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(button => button.props.accessibilityLabel ?? '')).toEqual(expect.arrayContaining(['Volver a dev', 'Volver a Agentes', 'Volver a Servidores', 'Agregar', 'Más']));
    expect(buttons).toHaveLength(16);
    for (const button of buttons) {
      const zone = touchZone(button);
      expect([button.props.accessibilityLabel, zone.height >= 48, zone.width >= 48]).toEqual([button.props.accessibilityLabel, true, true]);
    }
  });

  test('a key sinks 1 px and takes the pressed shadow in 80 ms, and rises when let go', () => {
    const onPress = jest.fn();
    render(<Keycap label="Reintentar" onPress={onPress} />);
    const key = screen.getByRole('button', { name: 'Reintentar' });
    const face = () => animatedStyle(screen.getByTestId('keycap-face'));
    expect(face().transform).toEqual([{ translateY: 0 }]);
    fireEvent(key, 'pressIn');
    advance(80);
    expect(face().transform).toEqual([{ translateY: 1 }]);
    expect(face().boxShadow).toBe('inset 0px 2px 3px rgba(0,0,0,0.18)');
    fireEvent(key, 'pressOut');
    advance(80);
    expect(face().transform).toEqual([{ translateY: 0 }]);
    fireEvent.press(key);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
