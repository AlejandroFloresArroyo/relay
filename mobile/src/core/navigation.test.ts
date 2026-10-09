import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalsHidden, relayDestination, returnFor, revealApprovals, TABS, type NavState } from './navigation.ts';

const names = {
  agent: (server: string, agent: string) => ({ 'atlas/dev': 'dev', 'atlas/research': 'research' } as Record<string, string>)[`${server}/${agent}`] ?? agent,
  server: (server: string) => ({ atlas: 'atlas' } as Record<string, string>)[server] ?? server,
};
const tabs = (focused: string, history: string[] = [focused]): NavState['routes'][number] => ({
  name: '(tabs)', key: 'tabs', state: { index: TABS.findIndex(t => t.key === focused), routes: TABS.map(t => ({ name: t.key, key: `${t.key}-key` })), history: history.map(key => ({ key: `${key}-key` })) },
});
const stack = (...routes: NavState['routes']): NavState => ({ index: routes.length - 1, routes });
const chat = (agent = 'dev', extra: Record<string, unknown> = {}) => ({ name: 'chat/[server]/[agent]', params: { server: 'atlas', agent, ...extra } });

test('the bar has eight tabs in the order of the ADR, with short labels and full names', () => {
  assert.deepEqual(TABS.map(t => t.key), ['agents', 'tools', 'board', 'work', 'jobs', 'approvals', 'servers', 'settings']);
  assert.deepEqual(TABS.map(t => t.short), ['AGENTES', 'HERRAM.', 'TABLERO', 'TRABAJO', 'TAREAS', 'APROB.', 'SERVID.', 'AJUSTES']);
  assert.deepEqual(TABS.map(t => t.name), ['Agentes', 'Herramientas', 'Tablero', 'Trabajo', 'Tareas', 'Aprobaciones', 'Servidores', 'Ajustes']);
});

test('every example of the ticket names its real origin and goes back to it', () => {
  assert.deepEqual(returnFor(stack(tabs('agents'), chat()), names), { label: 'Agentes', action: 'back' });
  const ficha = { name: 'agent/[server]/[agent]', params: { server: 'atlas', agent: 'dev' } };
  assert.deepEqual(returnFor(stack(tabs('agents'), ficha, { name: 'agent/[server]/[agent]/memory', params: { server: 'atlas', agent: 'dev' } }), names), { label: 'dev', action: 'back' });
  const server = { name: 'server/[server]', params: { server: 'atlas' } };
  for (const name of ['usage/[server]', 'presets/[server]', 'app-update/[server]'])
    assert.deepEqual(returnFor(stack(tabs('servers'), server, { name, params: { server: 'atlas' } }), names), { label: 'atlas', action: 'back' });
  assert.deepEqual(returnFor(stack(tabs('settings'), { name: 'notifications/[server]', params: { server: 'atlas' } }), names), { label: 'Ajustes', action: 'back' });
  assert.deepEqual(returnFor(stack(tabs('agents'), chat(), { name: 'tools/[server]', params: { server: 'atlas' } }), names), { label: 'dev', action: 'back' });
  // A Conversación opened from another one (the tablet list) names that one.
  assert.deepEqual(returnFor(stack(tabs('agents'), chat('research'), chat()), names), { label: 'research', action: 'back' });
});

test('the Herram. tab returns to the tab it was entered from, or to Agentes', () => {
  assert.deepEqual(returnFor(stack(tabs('tools', ['board', 'tools'])), names), { label: 'Tablero', action: 'back' });
  assert.deepEqual(returnFor(stack(tabs('tools', ['tools'])), names), { label: 'Agentes', action: 'parent', href: { pathname: '/agents' } });
  assert.equal(returnFor(stack(tabs('board', ['agents', 'board'])), names), null);
});

test('an external entry and a screen with nothing under it return to their parent in the hierarchy', () => {
  assert.deepEqual(returnFor(stack(tabs('settings'), { name: 'notices/[server]/[notice]', params: { server: 'atlas', notice: 'n', entry: '1' } }), names),
    { label: 'Aprobaciones', action: 'parent', href: { pathname: '/approvals' } });
  assert.deepEqual(returnFor(stack(chat('dev', { entry: '1' })), names), { label: 'Agentes', action: 'parent', href: { pathname: '/agents' } });
  assert.deepEqual(returnFor(stack({ name: 'agent/[server]/[agent]/soul', params: { server: 'atlas', agent: 'dev' } }), names),
    { label: 'dev', action: 'parent', href: { pathname: '/agent/[server]/[agent]', params: { server: 'atlas', agent: 'dev' } } });
  assert.deepEqual(returnFor(stack({ name: 'jobs/[server]/[agent]/[job]', params: { server: 'atlas', agent: 'dev', job: 'j' } }), names),
    { label: 'Tareas', action: 'parent', href: { pathname: '/jobs' }, select: 'atlas' });
  assert.deepEqual(returnFor(stack({ name: 'tools/[server]', params: { server: 'atlas' } }), names),
    { label: 'Herramientas', action: 'parent', href: { pathname: '/tools' }, select: 'atlas' });
  assert.deepEqual(returnFor(stack({ name: 'usage/[server]', params: { server: 'atlas' } }), names),
    { label: 'atlas', action: 'parent', href: { pathname: '/server/[server]', params: { server: 'atlas' } } });
  assert.deepEqual(returnFor(stack({ name: 'server/[server]', params: { server: 'atlas' } }), names), { label: 'Servidores', action: 'parent', href: { pathname: '/servers' } });
});

test('an origin with no name of its own, a partial state or an unknown route never throws and falls back to the parent', () => {
  assert.deepEqual(returnFor(stack({ name: 'share' }, chat()), names), { label: 'Agentes', action: 'parent', href: { pathname: '/agents' } });
  assert.deepEqual(returnFor(stack({ name: '(tabs)' }, chat()), names), { label: 'Agentes', action: 'back' });
  assert.equal(returnFor(stack({ name: 'share' }), names), null);
  assert.equal(returnFor(undefined, names), null);
  assert.equal(returnFor({ index: 0, routes: [] }, names), null);
  assert.deepEqual(returnFor(stack(tabs('agents'), { name: 'chat/[server]/[agent]', params: { server: ['atlas'], agent: ['dev'] } }), names), { label: 'Agentes', action: 'back' });
  assert.deepEqual(returnFor(stack(tabs('agents'), { name: 'chat/[server]/[agent]' }), names), { label: 'Agentes', action: 'back' });
});

test('each window place belongs to one tab, and only Agentes and Servidores details carry their list', () => {
  assert.deepEqual(relayDestination('/chat/A/dev'), { active: 'agents', list: 'agents' });
  assert.deepEqual(relayDestination('/agent/B/research/tools'), { active: 'agents', list: 'agents' });
  for (const path of ['/usage/A', '/presets/A', '/app-update/B']) assert.deepEqual(relayDestination(path), { active: 'servers', list: 'servers' });
  // Herramientas (two panels, D-TB-3) and the ficha (T-2) take the whole width without a list.
  assert.deepEqual(relayDestination('/tools'), { active: 'tools', list: null, fullWidth: true });
  assert.deepEqual(relayDestination('/tools/B'), { active: 'tools', list: null, fullWidth: true });
  assert.deepEqual(relayDestination('/server/A'), { active: 'servers', list: null, fullWidth: true });
  for (const key of ['agents', 'board', 'work', 'jobs', 'approvals', 'servers', 'settings']) assert.deepEqual(relayDestination(`/${key}`), { active: key, list: null });
  assert.deepEqual(relayDestination('/jobs/A/dev/job'), { active: 'jobs', list: null });
  assert.deepEqual(relayDestination('/work/A'), { active: 'work', list: null });
  assert.deepEqual(relayDestination('/notices/A/n'), { active: 'approvals', list: null });
  for (const path of ['/notifications/A', '/widget-preview', '/machinery-preview']) assert.deepEqual(relayDestination(path), { active: 'settings', list: null });
  for (const path of ['/connect', '/share', '/', '/notifications-other/B', '/app-update-other/B', '/server-list']) assert.equal(relayDestination(path), null);
});

test('the APROB. badge shows only while its key is not fully in view, and revealing it brings the key in', () => {
  assert.equal(approvalsHidden(0, 390), true);
  assert.equal(approvalsHidden(0, 594), false);
  const x = revealApprovals(390);
  assert.equal(x, 60);
  assert.equal(approvalsHidden(x, 390), false);
  // At the far end the target never scrolls past the content.
  assert.equal(revealApprovals(180), 270);
  assert.equal(approvalsHidden(204, 390), false);
  assert.equal(approvalsHidden(380, 390), true);
  assert.equal(revealApprovals(700), 0);
});

test("the container's root wraps the app's stack in expo-router's __root slot, and the return reads through it", () => {
  const wrapped = (state: NavState): NavState => ({ index: 0, routes: [{ name: '__root', state }] });
  assert.deepEqual(returnFor(wrapped(stack(tabs('agents'), chat())), names), { label: 'Agentes', action: 'back' });
  assert.deepEqual(returnFor(wrapped(stack(tabs('tools', ['agents', 'tools']))), names), { label: 'Agentes', action: 'back' });
  assert.equal(returnFor({ index: 0, routes: [{ name: '__root' }] }, names), null);
});
