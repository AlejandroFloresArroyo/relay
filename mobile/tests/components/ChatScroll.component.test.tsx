import { act, fireEvent, screen } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { scrollToEnd } from '../support/scroll';
import { json, respond, streamFixture } from '../support/transport';

const root = '/v1/agents/agentA';
const metrics = (offset: number) => ({ nativeEvent: { contentOffset: { x: 0, y: offset }, contentSize: { width: 390, height: 2200 }, layoutMeasurement: { width: 390, height: 600 } } });
async function mount() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, `${root}/chat`, json({ available: true, reason: null }));
  respond(serverA.url, `${root}/transcript`, json({ conversation: conversationA, sessionId: conversationA.sessionId, items: [{ kind: 'assistant', id: 'history', text: 'Historial anterior', at: 1791028800000 }] }));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />);
  await app.ready(); await screen.findByText('Historial anterior');
  await act(async () => { await jest.advanceTimersByTimeAsync(32); });
  scrollToEnd.mockClear();
  return { app, list: screen.getByLabelText('Mensajes de esta Conversación') };
}
async function grow(list: ReturnType<typeof screen.getByLabelText>) {
  fireEvent(list, 'contentSizeChange', 390, 2400);
  await act(async () => { await jest.advanceTimersByTimeAsync(32); });
}

test('sending pins the newest message despite stale momentum until the next user drag', async () => {
  const { list } = await mount();
  fireEvent(list, 'scrollBeginDrag', metrics(400)); fireEvent.scroll(list, metrics(400));
  const stream = streamFixture();
  respond(serverA.url, `${root}/runs`, json({ runId: 'scroll-turn', sessionId: conversationA.sessionId }), 'POST');
  respond(serverA.url, '/v1/runs/scroll-turn/events', stream.reply);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mensaje nuevo');
  fireEvent.press(screen.getByLabelText('Enviar'));
  await screen.findByText('Mensaje nuevo');
  fireEvent.scroll(list, metrics(450)); fireEvent(list, 'momentumScrollEnd', metrics(450));
  await grow(list); expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  scrollToEnd.mockClear();
  fireEvent(list, 'scrollBeginDrag', metrics(400)); fireEvent.scroll(list, metrics(400));
  await grow(list); expect(scrollToEnd).not.toHaveBeenCalled();
});

test.each(['momentumScrollEnd', 'scrollEndDrag'])('the final %s position restores following even when the previous scroll event was short of the end', async (event) => {
  const { list } = await mount();
  fireEvent(list, 'scrollBeginDrag', metrics(400)); fireEvent.scroll(list, metrics(1490));
  await grow(list); expect(scrollToEnd).not.toHaveBeenCalled();
  fireEvent(list, event, metrics(1600));
  await grow(list); expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
});
