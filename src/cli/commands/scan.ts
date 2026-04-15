import { Command } from 'commander';
import chalk from 'chalk';
import { loadContext } from '../context.js';
import { ProjectScanner } from '../../core/scanner/ProjectScanner.js';
import { logger } from '../../utils/logger.js';

export function scanCommand(): Command {
    return new Command('scan')
        .description('Scan the project and build the relationship graph')
        .option('-f, --force', 'Force a full rescan', false)
        .action(async (opts: any) => {
            try {
                const ctx = await loadContext();
                if (!ctx) return;

                const { config, graph, db } = ctx;
                const scanner = new ProjectScanner(config.rootDir, graph, config, db);

                console.log(chalk.bold('Starting project scan...'));
                const result = await scanner.scanProject(opts.force);

                if (result.errors.length > 0) {
                    console.log(chalk.yellow(`\nScan completed with ${result.errors.length} errors.`));
                    if (result.errors.length <= 10) {
                        result.errors.forEach(e => {
                            console.log(chalk.gray(`  - ${e.file}: ${e.error}`));
                        });
                    } else {
                        console.log(chalk.gray(`  (Showing first 10 errors. Check logs for details)`));
                        result.errors.slice(0, 10).forEach(e => {
                            console.log(chalk.gray(`  - ${e.file}: ${e.error}`));
                        });
                    }
                } else {
                    console.log(chalk.green('\nScan completed successfully!'));
                }

                console.log(chalk.gray(`Analyzed ${result.analyzedFiles}/${result.totalFiles} files`));
                console.log(chalk.gray(`Nodes created: ${result.nodesCreated}`));
                console.log(chalk.gray(`Edges created: ${result.edgesCreated}`));
                console.log(chalk.gray(`Duration: ${result.durationMs}ms`));

            } catch (err) {
                logger.error('Scan command failed', { error: String(err) });
                console.error(chalk.red('\nScan failed:'), String(err));
                process.exit(1);
            }
        });
}
