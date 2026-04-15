import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadContext } from '../context.js';
import { GraphQueryEngine } from '../../core/graph/GraphQueryEngine.js';
import { GraphPersistence } from '../../core/graph/GraphPersistence.js';

export function graphCommand(): Command {
    const cmd = new Command('graph').description('Explore the codebase relationship graph');

    cmd
        .command('stats')
        .description('Show graph statistics')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { graph } = ctx;
            const stats = graph.getStats();
            const engine = new GraphQueryEngine(graph);
            const topNodes = engine.getMostConnectedNodes(5);
            const cycles = engine.findCycles();

            console.log('\nGraph Statistics');
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Total nodes: ${chalk.cyan(stats.nodeCount)}`);
            console.log(`  Total edges: ${chalk.cyan(stats.edgeCount)}`);
            console.log(`  Detected cycles: ${cycles.length > 0 ? chalk.yellow(cycles.length) : chalk.green('0')}`);

            console.log('\nNodes by layer:');
            const layerTable = new Table({ head: [chalk.cyan('Layer'), chalk.cyan('Count')], colWidths: [20, 10] });
            for (const [layer, count] of Object.entries(stats.layerBreakdown)) {
                layerTable.push([layer, count]);
            }
            console.log(layerTable.toString());

            console.log('\nMost connected nodes:');
            const nodeTable = new Table({ head: [chalk.cyan('Name'), chalk.cyan('Kind'), chalk.cyan('Layer'), chalk.cyan('Connections')], colWidths: [30, 14, 12, 12] });
            for (const { node, connections } of topNodes) {
                nodeTable.push([node.name, node.kind, node.layer, connections]);
            }
            console.log(nodeTable.toString());
        });

    cmd
        .command('search <query>')
        .description('Search for nodes by name')
        .action(async (query: string) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { graph } = ctx;
            const nodes = graph.findNodesByName(query);

            if (nodes.length === 0) {
                console.log(chalk.yellow(`No nodes found matching: ${query}`));
                return;
            }

            const table = new Table({
                head: [chalk.cyan('Name'), chalk.cyan('Kind'), chalk.cyan('Layer'), chalk.cyan('File')],
                colWidths: [30, 14, 12, 50],
            });

            for (const node of nodes.slice(0, 30)) {
                table.push([
                    node.name,
                    node.kind,
                    node.layer,
                    path.relative(process.cwd(), node.filePath),
                ]);
            }
            console.log('\n' + table.toString());
            if (nodes.length > 30) console.log(chalk.gray(`... and ${nodes.length - 30} more`));
        });

    cmd
        .command('deps <name>')
        .description('Show all dependents of a node')
        .option('--depth <n>', 'Max propagation depth', '5')
        .action(async (name: string, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { graph } = ctx;

            const nodes = graph.findNodesByName(name);
            if (nodes.length === 0) {
                console.log(chalk.yellow(`No nodes found: ${name}`));
                return;
            }

            const node = nodes[0]!;
            const depth = parseInt(opts.depth as string, 10);
            const dependents = graph.getAllDependents(node.id, depth);

            console.log(`\nDependents of ${chalk.cyan(node.name)} (${node.kind}, ${node.layer}):`);
            if (dependents.size === 0) {
                console.log(chalk.green('  No dependents found'));
                return;
            }

            const table = new Table({
                head: [chalk.cyan('Name'), chalk.cyan('Kind'), chalk.cyan('Layer'), chalk.cyan('Depth'), chalk.cyan('File')],
                colWidths: [25, 14, 12, 8, 45],
            });

            for (const [depId, dep_depth] of dependents) {
                const depNode = graph.getNode(depId);
                if (depNode) {
                    table.push([depNode.name, depNode.kind, depNode.layer, dep_depth, path.relative(process.cwd(), depNode.filePath)]);
                }
            }
            console.log(table.toString());
        });

    cmd
        .command('export')
        .description('Export graph as JSON')
        .option('--label <label>', 'Snapshot label')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { graph, dataDir } = ctx;
            const persistence = new GraphPersistence(graph, dataDir);
            const snapPath = persistence.exportSnapshot(opts.label as string | undefined);
            console.log(chalk.green(`Graph exported to: ${snapPath}`));
        });

    cmd
        .command('path <from> <to>')
        .description('Find shortest dependency path between two nodes')
        .action(async (from: string, to: string) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { graph } = ctx;

            const fromNodes = graph.findNodesByName(from);
            const toNodes = graph.findNodesByName(to);

            if (fromNodes.length === 0 || toNodes.length === 0) {
                console.log(chalk.yellow(`Could not find both nodes: '${from}' and '${to}'`));
                return;
            }

            const engine = new GraphQueryEngine(graph);
            const result = engine.findShortestPath(fromNodes[0]!.id, toNodes[0]!.id);

            if (!result) {
                console.log(chalk.yellow(`No path found between '${from}' and '${to}'`));
                return;
            }

            console.log(`\nPath (${result.length} hop(s)):`);
            for (const node of result.path) {
                console.log(`  ${chalk.cyan(node.name)} (${node.kind}, ${node.layer})`);
            }
        });

    return cmd;
}