const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TopologicalPlanner } = require('../dist/core/ai/TopologicalPlanner.js');

function node(id, filePath, kind = 'file', layer = 'backend') {
  return {
    id,
    kind,
    name: path.basename(filePath),
    filePath,
    layer,
    language: 'typescript',
    metadata: {},
    hash: id,
    createdAt: 0,
    updatedAt: 0,
  };
}

function edge(id, kind, sourceId, targetId) {
  return {
    id,
    kind,
    sourceId,
    targetId,
    weight: 1,
    metadata: {},
    createdAt: 0,
  };
}

function createGraph(nodes, edges) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const edgeMap = new Map(edges.map(e => [e.id, e]));
  return {
    nodes: nodeMap,
    edges: edgeMap,
    adjacency: new Map(),
    reverseAdjacency: new Map(),
    getNode(id) {
      return nodeMap.get(id);
    },
    getNodesByFile(filePath) {
      const normalized = path.resolve(filePath);
      return [...nodeMap.values()].filter(n => path.resolve(n.filePath) === normalized);
    },
    getOutgoingEdges(nodeId) {
      return [...edgeMap.values()].filter(e => e.sourceId === nodeId);
    },
    getIncomingEdges(nodeId) {
      return [...edgeMap.values()].filter(e => e.targetId === nodeId);
    },
  };
}

test('orders imported dependencies before consumers', () => {
  const root = path.resolve('/repo');
  const repository = path.join(root, 'Repository.ts');
  const service = path.join(root, 'Service.ts');
  const controller = path.join(root, 'Controller.ts');

  const graph = createGraph(
    [
      node('repository', repository),
      node('service', service),
      node('controller', controller),
    ],
    [
      edge('service-repository', 'imports', 'service', 'repository'),
      edge('controller-service', 'imports', 'controller', 'service'),
    ],
  );

  const planner = new TopologicalPlanner(graph, root);
  const report = planner.planFromFiles([controller], 10);

  assert.deepEqual(report.executionPlan, [
    'Repository.ts',
    'Service.ts',
    'Controller.ts',
  ]);
  assert.equal(report.cycles.length, 0);
});

test('does not treat provides edges as dependency ordering edges', () => {
  const root = path.resolve('/repo');
  const source = path.join(root, 'module.ts');
  const fileNode = node('file', source, 'file');
  const functionNode = node('fn', source, 'function');

  const graph = createGraph(
    [fileNode, functionNode],
    [edge('provides', 'provides', 'file', 'fn')],
  );

  const planner = new TopologicalPlanner(graph, root);
  const report = planner.planFromFiles([source], 10);

  assert.equal(report.totalFiles, 1);
  assert.deepEqual(report.executionPlan, ['module.ts']);
  assert.equal(report.cycles.length, 0);
});

test('surfaces dependency cycles instead of presenting them as valid topology', () => {
  const root = path.resolve('/repo');
  const a = path.join(root, 'a.ts');
  const b = path.join(root, 'b.ts');

  const graph = createGraph(
    [node('a', a), node('b', b)],
    [
      edge('a-b', 'imports', 'a', 'b'),
      edge('b-a', 'imports', 'b', 'a'),
    ],
  );

  const planner = new TopologicalPlanner(graph, root);
  const report = planner.planFromFiles([a], 10);

  assert.equal(report.totalFiles, 2);
  assert.ok(report.cycles.length > 0);
});
