import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRendererModule } from './support/load-renderer-module.mjs';

const stamp = '2026-10-30T00:00:00Z';
function session(id, patch = {}) {
  return {
    sessionId: id,
    nodeId: id,
    providerKind: 'codex',
    role: 'worker',
    label: id,
    prompt: id,
    cwd: '/work',
    status: 'idle',
    createdAt: stamp,
    updatedAt: stamp,
    messages: [],
    ...patch,
  };
}
function state(sessions) {
  return {
    nodes: sessions.map((item) => ({ nodeId: item.sessionId, sessionId: item.sessionId })),
    clusters: {},
    reports: [],
    sessions: Object.fromEntries(sessions.map((item) => [item.sessionId, item])),
    collaborationSessions: {},
    chatProjects: {},
  };
}
function list(build, data, options = {}) {
  return build({ state: data, sessions: Object.values(data.sessions), diagnostics: [], query: '', showArchived: false, pinnedIds: [], ...options });
}

test('search and row tiers share recovery while terminal failures remain recent and requests remain actionable', async (t) => {
  const { buildSessionListModel: build } = await loadRendererModule('src/lib/sidebar-model.ts', t);
  const data = state([
    session('frozen'),
    session('stopped', { status: 'killed' }),
    session('running', { status: 'running' }),
    session('approval', { runtimeRequests: [{ id: 'r', status: 'open' }] }),
  ]);
  data.nodes[0].frozen = true;
  const model = list(build, data);
  assert.deepEqual(
    model.entries.map(({ session, tier }) => [session.sessionId, tier]),
    [
      ['frozen', 'attention'],
      ['stopped', 'recent'],
      ['running', 'running'],
      ['approval', 'attention'],
    ],
  );
  assert.equal(model.entries[1].recovery, undefined);
  assert.deepEqual(
    list(build, data, { query: 'Stopped' }).filteredSessions.map((item) => item.sessionId),
    ['stopped'],
    'terminal recovery stays searchable even when not pinned to attention',
  );
  assert.deepEqual(
    list(build, data, { query: 'Frozen by workflow' }).filteredSessions.map((item) => item.sessionId),
    ['frozen'],
  );
});

test('report search chooses the newest timestamp, cluster ownership preserves first-match behavior, and pins preserve stable ordering', async (t) => {
  const { buildSessionListModel: build } = await loadRendererModule('src/lib/sidebar-model.ts', t);
  const data = state([session('a'), session('b'), session('hidden', { archived: true })]);
  data.clusters = { first: { nodeIds: ['a'], frozen: false }, second: { nodeIds: ['a'], frozen: true } };
  data.reports = [
    { from: 'a', envelope: { ts: '2026-10-30T01:00:00Z' }, payload: { type: 'verdict', verdict: 'clean', summary: 'new signal' } },
    { from: 'a', envelope: { ts: stamp }, payload: { type: 'verdict', verdict: 'issues', summary: 'obsolete signal' } },
  ];
  assert.equal(list(build, data).entries[0].tier, 'recent');
  assert.deepEqual(
    list(build, data, { query: 'new signal' }).filteredSessions.map((item) => item.sessionId),
    ['a'],
  );
  assert.equal(list(build, data, { query: 'obsolete signal' }).entries.length, 0);
  assert.deepEqual(
    list(build, data, { showArchived: true, pinnedIds: ['hidden', 'b'] }).filteredSessions.map((item) => item.sessionId),
    ['hidden', 'b', 'a'],
  );
});

test('project membership stays explicit and pinning never duplicates project chats in Recents', async (t) => {
  const { buildSessionListModel: build, buildSidebarModel: sidebar } = await loadRendererModule('src/lib/sidebar-model.ts', t);
  const data = state([session('project-chat', { chatProjectId: 'project' }), session('loose')]);
  data.chatProjects.project = { projectId: 'project', label: 'Project', cwd: '/work', createdAt: stamp, updatedAt: stamp };
  const pinnedSessionIds = ['project-chat', 'loose'];
  const model = sidebar({ state: data, entries: list(build, data).entries, pinnedSessionIds, showArchivedSessions: false, sessionSearch: '' });
  assert.deepEqual(model.visiblePinnedIds, ['loose']);
  assert.deepEqual(
    model.baseProjectGroups[0].chats.map((item) => item.sessionId),
    ['project-chat'],
  );
  assert.deepEqual(
    model.unassignedEntries.map((entry) => entry.session.sessionId),
    ['loose'],
    'sharing a cwd does not invent membership',
  );
  assert.equal(model.recentEntries.length, 0, 'pinned loose chat renders exactly once');
});

test('all sidebar row variants use the same keyboard contract without activating nested row actions', async (t) => {
  const { SidebarChatRow } = await loadRendererModule('src/components/sidebar-chat-row.tsx', t);
  let activated = 0,
    prevented = 0;
  const chat = session('a');
  const row = SidebarChatRow({
    chat,
    onSelect: () => activated++,
    renderContextMenu: (actual, element) => {
      assert.equal(actual, chat);
      return element;
    },
    children: 'Example row',
    className: 'row',
  });
  const target = {};
  row.props.onKeyDown({ target, currentTarget: target, key: 'Enter', preventDefault: () => prevented++ });
  row.props.onKeyDown({ target, currentTarget: target, key: ' ', preventDefault: () => prevented++ });
  row.props.onKeyDown({ target: {}, currentTarget: target, key: 'Enter', preventDefault: () => prevented++ });
  row.props.onKeyDown({ target, currentTarget: target, key: 'ArrowDown', preventDefault: () => prevented++ });
  assert.equal(activated, 2);
  assert.equal(prevented, 2);
  assert.equal(row.props.role, 'button');
  assert.equal(row.props.tabIndex, 0);
});
