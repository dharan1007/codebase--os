import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
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
        .description('Watch for file changes and analyze impact in real-time')
        .option('--auto-apply', 'Automatically apply AI-suggested fixes (dangerous)')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph, db } = ctx;
            const tsAnalyzer = new TypeScriptAnalyzer(config.rootDir);
            const scanner = new ProjectScanner(config.rootDir, graph, config, db);
            const analyzer = new ImpactAnalyzer(graph, tsAnalyzer, db);

            console.log(chalk.bold('\nCodebase OS — Watch Mode'));
            console.log(chalk.gray('─'.repeat(50)));
            console.log(`  Project: ${chalk.cyan(config.name)}`);
            console.log(`  Provider: ${chalk.cyan(config.ai.provider)}`);
            console.log(`  Auto-analyze: ${chalk.cyan(String(config.watch.autoAnalyze))}`);
            console.log(`  Auto-apply: ${chalk.cyan(String(opts.autoApply || config.watch.autoApply))}`);
            console.log(chalk.gray('─'.repeat(50)));
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
                    renamed: chalk.yellow 
                };
                const color = colors[change.changeType] || chalk.blue;
                
                console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] `) + 
                    color(`${change.changeType.toUpperCase()}`) + ` ${relPath}`);

                try {
                    await scanner.scanFile(change.filePath);
                } catch (err) {
                    logger.debug('Re-scan failed', { file: change.filePath, error: String(err) });
                }

                if (!config.watch.autoAnalyze) return;

                try {
                    const report = analyzer.analyze(change);
                    
                    if (report.impactedNodes.length === 0 && report.crossLayerIssues.length === 0) {
                        return;
                    }

                    // For watch mode, we show a simplified impact summary
                    const sevColor = RichFormatter.severityColor(report.severity);
                    console.log(`  ${sevColor(`● ${report.severity.toUpperCase()}`)} — ${report.impactedNodes.length} nodes affected | Layers: ${report.affectedLayers.join(', ')}`);
                    
                    if (report.impactedNodes.length > 0) {
                        const topImpact = report.impactedNodes
                            .filter(n => ['breaking', 'major'].includes(n.severity))
                            .slice(0, 3);
                        
                        for (const node of topImpact) {
                            console.log(chalk.gray(`    → ${node.node.name} (${node.node.kind}): ${node.suggestedAction ?? node.reason}`));
                        }
                    }

                    if (report.crossLayerIssues.length > 0) {
                        console.log(chalk.yellow(`  ⚠ ${report.crossLayerIssues.length} synchronization issues detected. Run 'cos sync' for details.`));
                    }
                    console.log('');
                } catch (err) {
                    logger.debug('Analysis failed', { file: change.filePath, error: String(err) });
                }
            });

            process.on('SIGINT', () => {
                console.log(chalk.yellow('\n\nStopping watcher...'));
                watcher.stop();
                process.exit(0);
            });
        });
}