import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadContext } from '../context.js';
import { GraphVisualizer } from '../../core/graph/GraphVisualizer.js';
import type { Layer } from '../../types/index.js';

export function visualizeCommand(): Command {
    return new Command('visualize')
        .alias('viz')
        .description('Generate an interactive HTML visualization of the relationship graph')
        .option('--layer <layer>', 'Filter by layer (database|backend|api|frontend|config|infrastructure)')
        .option('--max-nodes <n>', 'Maximum nodes to render', '300')
        .option('--output <path>', 'Output file path', '.cos/graph.html')
        .option('--mermaid', 'Output Mermaid diagram instead of HTML')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { graph, config } = ctx;
            const visualizer = new GraphVisualizer(graph);
            const outputPath = path.resolve(process.cwd(), opts.output as string);
            const maxNodes = parseInt(opts.maxNodes as string, 10);

            if (opts.mermaid) {
                const mermaid = visualizer.exportMermaid({
                    layer: opts.layer as Layer | undefined,
                    maxNodes,
                });
                console.log('\n```mermaid');
                console.log(mermaid);
                console.log('```');
                return;
            }

            const spinner = ora('Generating visualization...').start();
            visualizer.exportHTMLVisualization(outputPath);
            spinner.succeed(chalk.green(`Graph visualization exported to: ${chalk.cyan(outputPath)}`));

            console.log(chalk.gray('\nOpen in your browser:'));
            console.log(chalk.cyan(`  file://${outputPath}`));
            console.log(chalk.gray('\nOr serve locally:'));
            console.log(chalk.cyan(`  npx serve ${path.dirname(outputPath)}`));
        });
}