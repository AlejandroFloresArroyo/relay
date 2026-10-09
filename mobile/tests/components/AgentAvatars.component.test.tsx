import { Image } from 'react-native';
import { act } from '@testing-library/react-native';
import { Avatar } from '@/ui/kit';
import { ChatHeader } from '@/screens/chat/ChatHeader';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { DEMO } from '@/state/app';
import { agentA, polling, seed, serverA } from '../support/fixtures';
import { renderApp } from '../support/renderApp';

const hermesImage = require('../../assets/avatars/hermes.png');
const caduceusImage = require('../../assets/avatars/caduceus.png');
const owlImage = require('../../assets/avatars/owl.png');
const agents = [
  { ...agentA, id: 'default', name: 'Principal' },
  { ...agentA, id: 'coding', name: 'Código' },
  { ...agentA, id: 'dev', name: 'Desarrollo' },
  { ...agentA, id: 'research', name: 'Investigación' },
];

test('actual Agents show local avatars outside DEMO and retain them across model changes, reordering and reopening', async () => {
  expect(DEMO).toBe(false);
  seed(); polling(serverA, agents);
  const app = renderApp(<AgentsScreen />);
  await app.findByText('Principal');
  expect(app.UNSAFE_queryAllByType(Image).map(image => image.props.source)).toEqual([hermesImage, owlImage, caduceusImage, owlImage]);
  const reordered = [agents[3], agents[1], agents[0], agents[2]].map(agent => ({ ...agent, model: 'another-fixture-model', name: agent.name + ' actualizado' }));
  polling(serverA, reordered);
  await act(async () => { app.probe.current!.refresh('A'); });
  await app.findByText('Investigación actualizado');
  expect(app.UNSAFE_queryAllByType(Image).map(image => image.props.source)).toEqual([owlImage, owlImage, hermesImage, caduceusImage]);
  app.unmount();
  const reopened = renderApp(<AgentsScreen />);
  await reopened.findByText('Principal actualizado');
  expect(reopened.UNSAFE_queryAllByType(Image).map(image => image.props.source)).toEqual([owlImage, owlImage, hermesImage, caduceusImage]);
});


test('the actual chat header uses the same assignment and Avatar retains explicitly supplied image sources', async () => {
  seed(); polling(serverA);
  const supplied = { uri: 'file:///fixture/explicit-avatar.png' };
  const app = renderApp(<>
    <ChatHeader agentId="coding" agentName="Código" serverName="Servidor A" model="fixture-model" status="on" onBack={() => {}} />
    <Avatar source={supplied} />
  </>);
  await app.ready();
  expect(app.UNSAFE_queryAllByType(Image).map(image => image.props.source)).toEqual([owlImage, supplied]);
});
