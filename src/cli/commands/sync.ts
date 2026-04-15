import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadContext } from '../context.js';
import { CrossLayerSynchronizer } from '../../core/sync/CrossLayerSynchronizer.js';
import { TypeScriptAnalyzer } from '../../core/scanner/TypeScriptAnalyzer.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';

export function syncCommand(): Command {
    return new Command('sync')
        .description('Detect and report cross-layer synchronization issues')
        .option('--json', 'Output raw JSON report')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph, db } = ctx;
            const tsAnalyzer = new TypeScriptAnalyzer(config.rootDir);
            const synchronizer = new CrossLayerSynchronizer(graph, tsAnalyzer, db);

            const spinner = ora('Running cross-layer synchronization check...').start();
            const report = synchronizer.runFullSync();
            spinner.stop();

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }

            console.log(RichFormatter.formatSyncReport(report));
        });
}