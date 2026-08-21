const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFileTool } = require('../dist/core/ai/tools/localTools.js');
const { MutationTransaction } = require('../dist/core/ai/MutationTransaction.js');
const { RelationshipGraph } = require('../dist/core/graph/RelationshipGraph.js');
const { TrafficController } = require('../dist/core/orchestrator/TrafficController.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-security-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeStore() {
  let nodeCounter = 0;
  let edgeCounter = 0;
  return {
    getAllNodes: () => [],
    getAllEdges: () => [],
    upsertNode: node => ({
      ...node,
      id: node.id || `n${++nodeCounter}`,
      metadata: node.metadata || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    upsertEdge: edge => ({ ...edge, id: edge.id || `e${++edgeCounter}`, createdAt: Date.now() }),
    deleteNode: () => {},
  };
}

test('native read_file denies secrets but permits template files', async t => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, '.env'), 'REAL_SECRET=do-not-expose\n');
  fs.writeFileSync(path.join(root, '.env.example'), 'REAL_SECRET=\n');

  const previous = process.env.COS_ALLOW_SECRET_READS;
  delete process.env.COS_ALLOW_SECRET_READS;
  t.after(() => {
    if (previous === undefined) delete process.env.COS_ALLOW_SECRET_READS;
    else process.env.COS_ALLOW_SECRET_READS = previous;
  });

  const denied = await readFileTool('.env', root);
  assert.equal(denied.success, false);
  assert.match(denied.error || '', /sensitive-file policy/i);

  const template = await readFileTool('.env.example', root);
  assert.equal(template.success, true);
  assert.match(template.output, /REAL_SECRET=/);
});

test('mutation transaction compensates a created file when history persistence fails', async t => {
  const root = tempRoot(t);
  const history = { record() { throw new Error('database unavailable'); } };
  const tx = new MutationTransaction(root, history, 'session-test', 'openai');

  const result = await tx.execute(1, {
    tool: 'write_file',
    args: { path: 'created.txt', content: 'durable or nothing\n' },
  });

  assert.equal(result.success, false);
  assert.match(result.error || '', /compensated|reverted/i);
  assert.equal(fs.existsSync(path.join(root, 'created.txt')), false);
});

test('relationship graph preserves POSIX case-sensitive file identities', { skip: process.platform === 'win32' }, () => {
  const graph = new RelationshipGraph(fakeStore());
  const common = { layer: 'backend', language: 'typescript', hash: 'x', metadata: {} };
  const upper = graph.addNode({ kind: 'file', name: 'Foo.ts', filePath: '/repo/src/Foo.ts', ...common });
  const lower = graph.addNode({ kind: 'file', name: 'foo.ts', filePath: '/repo/src/foo.ts', ...common });

  assert.deepEqual(graph.getNodesByFile('/repo/src/Foo.ts').map(node => node.id), [upper.id]);
  assert.deepEqual(graph.getNodesByFile('/repo/src/foo.ts').map(node => node.id), [lower.id]);
});

test('traffic controller rejects an empty provider sequence instead of hanging', async () => {
  const controller = TrafficController.createIsolated();
  controller.setNetworkExecutor(async () => { throw new Error('should not execute'); });
  await assert.rejects(
    controller.schedule({ taskType: 'reasoning', priority: 'high', context: 'x', maxTokens: 10 }, []),
    /NO_PROVIDER_AVAILABLE/,
  );
});

test('traffic controller fails over to the next provider', async () => {
  const controller = TrafficController.createIsolated();
  const seen = [];
  controller.setNetworkExecutor(async (_request, provider) => {
    seen.push(provider);
    if (provider === 'openai') throw new Error('temporary provider failure');
    return {
      content: 'ok',
      usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 },
      provider,
      model: 'test-model',
    };
  });

  const result = await controller.schedule(
    { taskType: 'reasoning', priority: 'high', context: 'hello', maxTokens: 10 },
    ['openai', 'anthropic'],
  );
  assert.equal(result.provider, 'anthropic');
  assert.deepEqual(seen.slice(0, 2), ['openai', 'anthropic']);
});
