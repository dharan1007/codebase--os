import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { loadContext } from '../context.js';
import { ImpactAnalyzer } from '../../core/impact/ImpactAnalyzer.js';
import { TypeScriptAnalyzer } from '../../core/scanner/TypeScriptAnalyzer.js';
import type { FileChange } from '../../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { RichFormatter } from '../../core/output/RichFormatter.js';

const VALID_CHANGE_TYPES: Array<FileChange['changeType']> = ['modified', 'added', 'deleted'];

export function analyzeCommand(): Command {
    return new Command('analyze')
        .alias('analyse')
        .description('Analyze the impact of a file change')
        .argument('<file>', 'File path to analyze impact for')
        .option('--type <type>', 'Change type (modified|added|deleted)', 'modified')
        .option('--json', 'Output raw JSON report')
        .action(async (file: string, opts: { type?: string; json?: boolean }) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const changeType = opts.type ?? 'modified';
            if (!VALID_CHANGE_TYPES.includes(changeType as FileChange['changeType'])) {
                console.error(
                    chalk.red(
                        `Invalid change type: ${changeType}. Expected one of: ${VALID_CHANGE_TYPES.join(', ')}`
                    )
                );
                process.exitCode = 1;
                return;
            }

            const { config, graph, db } = ctx;
            const absolutePath = path.resolve(process.cwd(), file);

            if (!fs.existsSync(absolutePath) && changeType !== 'deleted') {
                console.error(chalk.red(`File not found: ${absolutePath}`));
                process.exitCode = 1;
                return;
            }

            const tsAnalyzer = new TypeScriptAnalyzer(config.rootDir);
            const analyzer = new ImpactAnalyzer(graph, tsAnalyzer, db);

            const content = changeType !== 'deleted' ? fs.readFileSync(absolutePath, 'utf8') : undefined;
            const change: FileChange = {
                id: uuidv4(),
                filePath: absolutePath,
                changeType: changeType as FileChange['changeType'],
                newContent: content,
                timestamp: Date.now(),
            };

            const report = await analyzer.analyze(change);

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }

            console.log(
                RichFormatter.formatImpactReport({
                    ...report,
                    triggerChange: {
                        ...report.triggerChange,
                        filePath: path.relative(process.cwd(), absolutePath),
                    },
                })
            );
        });
}