import { DeviceEventEmitter } from 'react-native';
import { act } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

// gesture-handler's recognizers are native: its jestSetup (jest.config.cjs) swaps them for a module
// that delivers events straight to the gesture's callbacks. Gestures are found by `.withTestId(id)`.

/** Drags the pan gesture `testId`: it activates, moves through each translation step, then lifts at the last one. */
export function drag(testId: string, steps: { x?: number; y?: number }[]) {
  const moves = steps.map(({ x = 0, y = 0 }) => ({ translationX: x, translationY: y }));
  act(() => {
    fireGestureHandler(getByGestureTestId(testId), [
      { state: State.BEGAN }, { state: State.ACTIVE, translationX: 0, translationY: 0 }, ...moves, { state: State.END, ...moves.at(-1) },
    ]);
  });
}

/**
 * Like `drag`, but the finger stays down after the last step, so the screen can be checked mid-gesture;
 * `move()` carries on through more steps, `release()` lifts it at the last one and `cancel()` has the system cancel it. `fireGestureHandler`
 * always lifts, so this sends the double's events itself.
 */
export function hold(testId: string, steps: { x?: number; y?: number }[]) {
  const { handlerTag } = getByGestureTestId(testId) as unknown as { handlerTag: number };
  const at = ({ x = 0, y = 0 } = {}) => ({ x: 0, y: 0, absoluteX: 0, absoluteY: 0, velocityX: 0, velocityY: 0, numberOfPointers: 1, translationX: x, translationY: y });
  const send = (event: string, state: State, oldState: State | undefined, step?: { x?: number; y?: number }) =>
    DeviceEventEmitter.emit(event, { handlerTag, state, ...(oldState === undefined ? null : { oldState }), ...at(step) });
  let last = steps.at(-1);
  const move = (more: { x?: number; y?: number }[]) => act(() => {
    for (const step of more) send('onGestureHandlerEvent', State.ACTIVE, undefined, step);
    last = more.at(-1) ?? last;
  });
  act(() => {
    send('onGestureHandlerStateChange', State.BEGAN, State.UNDETERMINED);
    send('onGestureHandlerStateChange', State.ACTIVE, State.BEGAN);
  });
  move(steps);
  return {
    move,
    release: () => act(() => { send('onGestureHandlerStateChange', State.END, State.ACTIVE, last); }),
    /** The system takes the gesture away (an incoming gesture, the app going to the background). */
    cancel: () => act(() => { send('onGestureHandlerStateChange', State.CANCELLED, State.ACTIVE, last); }),
  };
}

/** A long press on `testId`: down, recognized after `duration` ms, lifted. The double fires the three at once. */
export function longPress(testId: string, duration: number) {
  act(() => {
    fireGestureHandler(getByGestureTestId(testId), [{ state: State.BEGAN }, { state: State.ACTIVE, duration }, { state: State.END, duration }]);
  });
}

/** A tap gesture `testId` recognized: down, recognized, lifted. A double tap's double fires the same three. */
export function tap(testId: string) {
  act(() => {
    fireGestureHandler(getByGestureTestId(testId), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
  });
}
