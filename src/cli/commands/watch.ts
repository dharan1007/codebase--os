import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import { loadContext } from '../context.js';
import { FileWatcher } from '../../core/watcher/FileWatcher.js';
import { ImpactAnalyzer } from '../../core/impact/ImpactAnalyzer.js';
import { ProjectScanner } from '../../core/scanner/ProjectScanner.js';
import { TypeScriptAnalyzer } from '../../core/scanner/TypeScriptAnalyzer.js';
import type { FileChange } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';
import { normalizePath } from '../../utils/paths.js';

export function watchCommand(): Command {
    return new Command('watch')
        .description('Read-only watch mode: refresh graph state and report impact when files change')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph, db } = ctx;
            const tsAnalyzer = new TypeScriptAnalyzer(config.rootDir);
            const scanner = new ProjectScanner(config.rootDir, graph, config, db);
            const analyzer = new ImpactAnalyzer(graph, tsAnalyzer, db);

            console.log(chalk.bold('\nCodebase OS — Read-Only Watch Mode'));
            console.log(chalk.gray('─'.repeat(56)));
            console.log(`  Project:      ${chalk.cyan(config.name)}`);
            console.log(`  Auto-analyze: ${chalk.cyan(String(config.watch.autoAnalyze))}`);
            console.log(`  Mutation:     ${chalk.gray('disabled; use cos propagate for verified downstream changes')}`);
            console.log(chalk.gray('─'.repeat(56)));
            console.log(chalk.gray('\nWatching for changes... (Ctrl+C to stop)\n'));

            const watcher = new FileWatcher(config);
            watcher.start(async (change: FileChange) => {
                const normalizedPath = normalizePath(change.filePath);
                change.filePath = normalizedPath;

                const relPath = path.relative(config.rootDir, normalizedPath).replace(/\\/g, '/');
                const colors: Record<string, chalk.Chalk> = {
                    added: chalk.green,
                    deleted: chalk.red,
                    modified: chalk.cyan,
                    renamed: chalk.yellow,
                    moved: chalk.yellow,
                };
                const color = colors[change.changeType] || chalk.blue;
                console.log(
                    chalk.gray(`[${new Date().toLocaleTimeString()}] `) +
                    color(change.changeType.toUpperCase()) +
                    ` ${relPath}`,
                );

                try {
                    await scanner.scanFile(change.filePath);
                } catch (err) {
                    logger.warn('Watch graph refresh failed', { file: change.filePath, error: String(err) });
                    console.log(chalk.red(`  Graph refresh failed: ${String(err)}`));
                    return;
                }

                if (!config.watch.autoAnalyze) return;

                try {
                    const report = analyzer.analyze(change);
                    if (report.impactedNodes.length === 0 && report.crossLayerIssues.length === 0) return;

                    const severity = RichFormatter.severityColor(report.severity);
                    console.log(
                        `  ${severity(report.severity.toUpperCase())} — ` +
                        `${report.impactedNodes.length} nodes affected | Layers: ${report.affectedLayers.join(', ')}`,
                    );

                    for (const impacted of report.impactedNodes
                        .filter(node => ['breaking', 'major'].includes(node.severity))
                        .slice(0, 5)) {
                        console.log(
                            chalk.gray(
                                `    ${impacted.node.name} (${impacted.node.kind}): ` +
                                `${impacted.suggestedAction ?? impacted.reason}`,
                            ),
                        );
                    }

                    if (report.crossLayerIssues.length > 0) {
                        console.log(chalk.yellow(
                            `  ${report.crossLayerIssues.length} cross-layer issue(s) detected. Run cos sync for details.`,
                        ));
                    }
                    console.log('');
                } catch (err) {
                    logger.warn('Watch impact analysis failed', { file: change.filePath, error: String(err) });
                    console.log(chalk.yellow(`  Impact analysis unavailable: ${String(err)}`));
                }
            });

            process.once('SIGINT', () => {
                console.log(chalk.yellow('\nStopping watcher...'));
                watcher.stop();
                process.exitCode = 130;
            });
        });
}
