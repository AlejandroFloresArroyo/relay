import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { clipboard } from '../support/clipboard';
import { buildBlocks } from '@/core/transcript';
import { ChatTranscript } from '@/screens/chat/ChatTranscript';
import { ChatScreen } from '@/screens/ChatScreen';
import { F } from '@/theme/tokens';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, respond } from '../support/transport';


const code = '  const literal = "**sin formato** | `sin tocar`";\n\tconsole.log(literal);\n';
const markdown = [
  '## Qué pasó',
  '',
  'Consulta [issue #212](https://example.com/issues/212).',
  '',
  '| Suite | Ahora |',
  '| --- | --- |',
  '| Integración | 24/24 |',
  '',
  '```js',
  code + '```',
].join('\n');


test('assistant Markdown exposes headings, table cells, safe links and copies fenced code verbatim', async () => {
  jest.mocked(Linking.openURL).mockResolvedValueOnce(undefined);
  render(<ChatTranscript blocks={buildBlocks([
    { kind: 'user', id: 'u1', text: '**Mensaje literal**', at: 1 },
    { kind: 'assistant', id: 'a1', text: markdown, at: 2 },
  ], false)} column={340} now={0} onWaitingPress={() => {}} />);

  expect(screen.getByRole('header', { name: 'Qué pasó' })).toBeVisible();
  expect(screen.getByText('Suite')).toBeVisible();
  expect(screen.getByText('Integración')).toBeVisible();
  expect(screen.getByRole('header', { name: 'Qué pasó' }).props.selectable).toBe(true);
  expect(screen.getByText('24/24')).toBeVisible();
  expect(screen.getByText('**Mensaje literal**')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByRole('link', { name: 'issue #212' })); });
  expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/issues/212');
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'COPIAR' })); });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith(code);
  expect(screen.getByText('COPIADO')).toBeVisible();
});

test('the real chat loads raw Agent Markdown through AppProvider and exposes the formatted response', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/agents/agentA/chat', json({ available: true, reason: null }));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({
    sessionId: conversationA.sessionId, conversation: conversationA,
    items: [{ kind: 'assistant', id: 'markdown-response', text: markdown, at: 2 }],
  }));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />);
  await app.ready();
  await waitFor(() => expect(screen.getByRole('header', { name: 'Qué pasó' })).toBeVisible());
  expect(screen.getByText('Integración')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'COPIAR' })); });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith(code);
});

test('nested lists, escaped table pipes, quotes and inline emphasis remain readable and selectable', () => {
  const text = '- Principal\n  3. Subpaso\n     - **Importante** y *énfasis*\n\n> Una cita\n\n| Literal | Código |\n| --- | --- |\n| a\\|b | `x|y` |\n\n\\*literal\\* y `**sin negrita**`';
  render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'a2', text, at: 1 }], false)} column={340} now={0} onWaitingPress={() => {}} />);
  expect(screen.getByText('Principal')).toBeVisible();
  expect(screen.getByText('3.')).toBeVisible();
  expect(screen.getByText('Subpaso')).toBeVisible();
  expect(screen.getByText('Importante')).toHaveStyle({ fontFamily: F.sans['700'] });
  expect(screen.getByText('énfasis')).toHaveStyle({ fontStyle: 'italic' });
  expect(screen.getByText('Una cita')).toBeVisible();
  expect(screen.getByText('a|b')).toBeVisible();
  expect(screen.getByText('x|y')).toBeVisible();
  expect(screen.getByText('**sin negrita**')).toBeVisible();
});

test('reference links dispatch only resolved web destinations and keep unsafe references inert', async () => {
  const text = '[Detalle][ref] [Inerte][bad]\n\n[ref]: https://example.com/details\n[bad]: javascript:alert(1)';
  jest.mocked(Linking.openURL).mockResolvedValueOnce(undefined);
  render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'reference', text, at: 1 }], false)} column={340} now={0} onWaitingPress={() => {}} />);
  expect(screen.queryByRole('link', { name: 'Inerte' })).toBeNull();
  await act(async () => { fireEvent.press(screen.getByRole('link', { name: 'Detalle' })); });
  expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/details');
  expect(screen.queryByText('[ref]: https://example.com/details')).toBeNull();
});

test('unsafe links never cross the native boundary while approved HTTP and HTTPS links do', async () => {
  const text = '[Seguro](http://example.com/path?q=1) [Seguro TLS](https://example.com) [JavaScript](javascript:alert(1)) [Archivo](file:///tmp/secret) [Datos](data:text/html,hello)';
  jest.mocked(Linking.openURL).mockResolvedValue(undefined);
  render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'a3', text, at: 1 }], false)} column={340} now={0} onWaitingPress={() => {}} />);
  expect(screen.getAllByRole('link')).toHaveLength(2);
  for (const name of ['JavaScript', 'Archivo', 'Datos']) {
    expect(screen.queryByRole('link', { name })).toBeNull();
    fireEvent.press(screen.getByText(name));
  }
  expect(Linking.openURL).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByRole('link', { name: 'Seguro' })); });
  await act(async () => { fireEvent.press(screen.getByRole('link', { name: 'Seguro TLS' })); });
  expect(Linking.openURL).toHaveBeenNthCalledWith(1, 'http://example.com/path?q=1');
  expect(Linking.openURL).toHaveBeenNthCalledWith(2, 'https://example.com');
});

test.each(['rejection', 'false'] as const)('clipboard %s is visible and a second press recovers', async (failure) => {
  if (failure === 'rejection') clipboard.setStringAsync.mockRejectedValueOnce(new Error('Denied'));
  else clipboard.setStringAsync.mockResolvedValueOnce(false);
  render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'a4', text: '```txt\n  intacto **literal**\n```', at: 1 }], false)} column={340} now={0} onWaitingPress={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'COPIAR' })); });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByText('COPIADO')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'COPIAR' })); });
  expect(clipboard.setStringAsync).toHaveBeenLastCalledWith('  intacto **literal**\n');
  expect(screen.getByText('COPIADO')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('streaming incomplete prose stays literal and an open fence still copies exact partial output', async () => {
  const app = render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'partial', text: '**pendiente [enlace](https://exa', at: 1 }], true)} column={340} now={0} onWaitingPress={() => {}} />);
  expect(screen.getByText('**pendiente [enlace](https://exa')).toBeVisible();
  expect(screen.queryByRole('link')).toBeNull();
  app.rerender(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'partial', text: '```js\n  const x = \"**literal**\";', at: 1 }], true)} column={340} now={0} onWaitingPress={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'COPIAR' })); });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith('  const x = \"**literal**\";');
});

test('a confirmed redirected user instruction is plain text with a delivery marker', () => {
  render(<ChatTranscript blocks={buildBlocks([
    { kind: 'user', id: 'normal', text: 'Mensaje normal', at: 1 },
    { kind: 'user', id: 'steered', text: '## Instrucción literal', redirected: true, at: 2 },
  ], false)} column={340} now={0} onWaitingPress={() => {}} />);
  expect(screen.getAllByText('REDIRIGIDO')).toHaveLength(1);
  expect(screen.getByText('## Instrucción literal')).toBeVisible();
  expect(screen.queryByRole('header')).toBeNull();
});

test('link-opening failure is visible rather than silently swallowed', async () => {
  render(<ChatTranscript blocks={buildBlocks([{ kind: 'assistant', id: 'link-error', text: '[Detalle](https://example.com)', at: 1 }], false)} column={340} now={0} onWaitingPress={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByRole('link', { name: 'Detalle' })); });
  expect(screen.getByRole('alert')).toBeVisible();
});
