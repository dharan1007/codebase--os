import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import type { BlastRadiusReport } from '../../core/ai/TopologicalPlanner.js';

const LAYER_COLOR: Record<string, (value: string) => string> = {
    database: chalk.yellow,
    backend: chalk.cyan,
    api: chalk.blue,
    frontend: chalk.green,
    config: chalk.gray,
    infrastructure: chalk.magenta,
};

const COMPLEXITY_COLOR: Record<string, (value: string) => string> = {
    low: chalk.green,
    medium: chalk.yellow,
    high: chalk.red,
};

function layerStr(layer: string): string {
    return (LAYER_COLOR[layer] ?? chalk.white)(`[${layer}]`);
}

function printBlastRadius(report: BlastRadiusReport): void {
    const separator = chalk.gray('─'.repeat(60));
    console.log('');
    console.log(chalk.bold('Blast Radius Analysis'));
    console.log(separator);

    if (report.totalFiles === 0) {
        console.log(chalk.yellow('  No affected files found in graph.'));
        console.log(chalk.gray('  Run cos scan first to build the relationship graph.'));
        return;
    }

    const layerParts = Object.entries(report.layerBreakdown)
        .map(([layer, count]) => `${count} ${layer}`)
        .join(', ');
    const complexityLabel = COMPLEXITY_COLOR[report.estimatedComplexity](
        report.estimatedComplexity.toUpperCase(),
    );
    console.log(`  ${chalk.bold(String(report.totalFiles))} files across ${chalk.white(layerParts)}`);
    console.log(`  Complexity: ${complexityLabel}`);
    console.log('');

    console.log(chalk.bold('Dependency-First Execution Plan'));
    console.log(chalk.gray('  (dependency files before consumers when the typed dependency graph is acyclic)'));
    console.log(separator);

    const maxFileLen = Math.max(...report.affectedFiles.map(file => file.relativePath.length), 10);
    for (const file of report.affectedFiles) {
        const order = chalk.gray(`[${String(file.executionOrder).padStart(2, ' ')}]`);
        const rootMark = file.isRoot ? chalk.cyan(' *') : '  ';
        const rel = file.relativePath.padEnd(Math.min(maxFileLen, 52));
        const layer = layerStr(file.layer).padEnd(16);
        const hub = file.dependentCount >= 5
            ? chalk.red(` hub(${file.dependentCount} dependents)`)
            : '';
        console.log(`  ${order}${rootMark} ${chalk.white(rel)} ${layer}${hub}`);
    }

    console.log('');
    console.log(chalk.gray('  * = root file directly involved in the task'));

    if (report.crossLayerWarnings.length > 0) {
        console.log('');
        console.log(chalk.bold.yellow('Architecture Warnings'));
        console.log(separator);
        for (const warning of report.crossLayerWarnings) {
            console.log(chalk.yellow(`  [!] ${warning}`));
        }
    }

    if (report.cycles.length > 0) {
        console.log('');
        console.log(chalk.bold.red('Dependency Cycles Found'));
        console.log(separator);
        for (const cycle of report.cycles) console.log(chalk.red(`  [cycle] ${cycle}`));
        console.log(chalk.yellow('  A cycle has no valid total topological order and requires explicit review.'));
    } else if (report.totalFiles > 1) {
        console.log('');
        console.log(chalk.green('  No dependency cycles detected in the affected subgraph.'));
    }
}

export function planCommand(): Command {
    return new Command('plan')
        .description('Compute typed blast radius and dependency-first file ordering (no changes made)')
        .argument('<task>', 'Natural-language task to analyze')
        .option('--file <path>', 'Compute plan starting from a specific file instead of task discovery')
        .option('--depth <n>', 'Override dependency traversal depth (1-50)')
        .action(async (task: string, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph } = ctx;
            if (graph.nodes.size === 0) {
                console.log(chalk.yellow('\n  Graph is empty. Run cos scan first.\n'));
                return;
            }

            let depth: number | undefined;
            if (opts.depth !== undefined) {
                depth = Number.parseInt(String(opts.depth), 10);
                if (!Number.isInteger(depth) || depth < 1 || depth > 50) {
                    console.log(chalk.red('\n  --depth must be an integer from 1 to 50.\n'));
                    return;
                }
            }

            const spinner = ora('Computing typed blast radius...').start();
            const planner = new TopologicalPlanner(graph, config.rootDir);
            let report: BlastRadiusReport;

            try {
                if (opts.file) {
                    const absolutePath = path.isAbsolute(opts.file)
                        ? path.resolve(opts.file)
                        : path.resolve(config.rootDir, opts.file);
                    report = planner.planFromFiles([absolutePath], depth);
                } else {
                    report = planner.planFromTask(task, depth);
                }
                spinner.stop();
            } catch (err) {
                spinner.fail(`Plan failed: ${String(err)}`);
                return;
            }

            console.log('');
            console.log(chalk.bold('Codebase OS — Change Plan'));
            console.log(chalk.gray('─'.repeat(60)));
            console.log(`  Task:  ${chalk.cyan(task)}`);
            console.log(`  Root:  ${chalk.gray(config.rootDir)}`);
            console.log(`  Graph: ${chalk.gray(`${graph.nodes.size} nodes, ${graph.edges.size} edges`)}`);
            if (depth !== undefined) console.log(`  Depth: ${chalk.gray(String(depth))}`);

            printBlastRadius(report);

            console.log('');
            console.log(chalk.gray('─'.repeat(60)));
            if (report.totalFiles > 0) {
                console.log(chalk.bold('  To start an evidence-gated agent session:'));
                console.log(`    ${chalk.cyan(`cos agent "${task}"`)}`);
                console.log('');
                console.log(chalk.gray('  The agent receives this ordering as planning context;'));
                console.log(chalk.gray('  runtime verification—not the model—decides whether the task is complete.'));
            }
            console.log('');
        });
}
