import chalk from 'chalk';
import Table from 'cli-table3';
import path from 'path';
import fs from 'fs';
import type { ImpactReport, SyncReport, SyncIssue, AITask, AITaskResult } from '../../types/index.js';

export class RichFormatter {
    static formatDiff(diff: string, maxLines = 80): string {
        const lines = diff.split('\n');
        const shown = lines.slice(0, maxLines);
        const out: string[] = [];

        for (const line of shown) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                out.push(chalk.green(line));
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                out.push(chalk.red(line));
            } else if (line.startsWith('@@')) {
                out.push(chalk.cyan(line));
            } else if (line.startsWith('diff ') || line.startsWith('index ')) {
                out.push(chalk.bold.gray(line));
            } else if (line.startsWith('+++') || line.startsWith('---')) {
                out.push(chalk.bold(line));
            } else {
                out.push(chalk.gray(line));
            }
        }

        if (lines.length > maxLines) {
            out.push(chalk.gray(`... ${lines.length - maxLines} more lines`));
        }

        return out.join('\n');
    }

    static formatImpactReport(report: ImpactReport): string {
        const severityColor = RichFormatter.severityColor;
        const out: string[] = [];

        out.push('');
        out.push(chalk.bold('Impact Analysis Report'));
        out.push(chalk.gray('─'.repeat(70)));
        out.push(`  File:     ${chalk.cyan(report.triggerChange.filePath)}`);
        out.push(`  Change:   ${report.triggerChange.changeType}`);
        out.push(`  Severity: ${severityColor(report.severity)(report.severity.toUpperCase())}`);
        out.push(`  Scopes:   ${report.scope.join(', ')}`);
        out.push(`  Layers:   ${report.affectedLayers.join(' → ')}`);
        out.push('');

        if (report.impactedNodes.length === 0) {
            out.push(chalk.green('  No downstream impact detected.'));
        } else {
            out.push(chalk.bold(`  Impacted Nodes (${report.impactedNodes.length})`));
            const table = new Table({
                head: [
                    chalk.cyan('Node'),
                    chalk.cyan('Kind'),
                    chalk.cyan('Layer'),
                    chalk.cyan('Severity'),
                    chalk.cyan('Needs Update'),
                ],
                colWidths: [28, 14, 12, 12, 14],
                wordWrap: true,
            });

            for (const n of report.impactedNodes.slice(0, 25)) {
                table.push([
                    n.node.name,
                    n.node.kind,
                    n.node.layer,
                    severityColor(n.severity)(n.severity),
                    n.requiresUpdate ? chalk.red('Yes') : chalk.green('No'),
                ]);
            }
            out.push(table.toString());
            if (report.impactedNodes.length > 25) {
                out.push(chalk.gray(`  ... and ${report.impactedNodes.length - 25} more`));
            }
        }

        if (report.crossLayerIssues.length > 0) {
            out.push('');
            out.push(chalk.bold(`  Cross-Layer Issues (${report.crossLayerIssues.length})`));
            for (const issue of report.crossLayerIssues) {
                const arrow = `${issue.sourceLayer} → ${issue.targetLayer}`;
                out.push(`  ${severityColor(issue.severity)('●')} [${chalk.bold(arrow)}] ${issue.description}`);
                if (issue.resolution) {
                    out.push(chalk.gray(`    Fix: ${issue.resolution}`));
                }
            }
        }

        out.push('');
        out.push(chalk.gray(`Report ID: ${report.id}  |  ${new Date(report.timestamp).toLocaleString()}`));
        return out.join('\n');
    }

    static formatSyncReport(report: SyncReport): string {
        const out: string[] = [];
        out.push('');
        out.push(chalk.bold('Synchronization Report'));
        out.push(chalk.gray('─'.repeat(70)));
        out.push(report.summary);
        out.push('');

        if (report.issues.length === 0) {
            out.push(chalk.green('  All layers are synchronized.'));
            return out.join('\n');
        }

        const groupByKind = (issues: SyncIssue[]) => {
            const map = new Map<string, SyncIssue[]>();
            for (const i of issues) {
                const arr = map.get(i.kind) ?? [];
                arr.push(i);
                map.set(i.kind, arr);
            }
            return map;
        };

        const kindLabel: Record<string, string> = {
            type_mismatch: 'Type Mismatches',
            missing_field: 'Missing Fields',
            broken_reference: 'Broken References',
            schema_drift: 'Schema Drift',
            api_drift: 'API Drift',
        };

        const grouped = groupByKind(report.issues);
        for (const [kind, issues] of grouped) {
            out.push(chalk.bold(`  ${kindLabel[kind] ?? kind} (${issues.length})`));
            const table = new Table({
                head: [chalk.cyan('Severity'), chalk.cyan('Source'), chalk.cyan('Description')],
                colWidths: [12, 30, 40],
                wordWrap: true,
            });
            for (const issue of issues) {
                table.push([
                    RichFormatter.severityColor(issue.severity)(issue.severity),
                    issue.sourceFile,
                    issue.description,
                ]);
            }
            out.push(table.toString());
        }

        if (report.autoFixed.length > 0) {
            out.push(chalk.green(`  Auto-fixed: ${report.autoFixed.length} issue(s)`));
        }

        return out.join('\n');
    }

    static formatAITasks(tasks: AITask[]): string {
        const out: string[] = [];
        out.push('');
        out.push(chalk.bold(`Planned Tasks (${tasks.length})`));
        out.push(chalk.gray('─'.repeat(70)));

        const kindColor: Record<string, chalk.Chalk> = {
            fix: chalk.red,
            update: chalk.yellow,
            generate: chalk.green,
            refactor: chalk.blue,
            sync: chalk.cyan,
        };

        tasks.forEach((t, i) => {
            const kc = kindColor[t.kind] ?? chalk.white;
            out.push(`  ${chalk.bold(String(i + 1).padStart(2))}. ${kc(`[${t.kind.toUpperCase()}]`)} ${chalk.gray(t.targetFile.split(/[/\\]/).slice(-2).join('/'))}`);
            out.push(chalk.gray(`      ${t.description}`));
        });

        return out.join('\n');
    }

    static formatDiagnostics(reports: any[], rootDir: string): string {
        const out: string[] = [];
        const table = new Table({
            head: [chalk.cyan('File'), chalk.cyan('Tool'), chalk.cyan('Line'), chalk.cyan('Issue')],
            colWidths: [35, 12, 10, 60],
            wordWrap: true,
        });

        for (const report of reports) {
            const rel = path.relative(rootDir, report.filePath);
            for (const d of report.errors.concat(report.warnings).slice(0, 50)) {
                table.push([
                    rel,
                    d.tool,
                    chalk.gray(String(d.line)),
                    d.severity === 'error' ? chalk.red(d.message) : chalk.yellow(d.message),
                ]);
            }
        }

        out.push(table.toString());
        return out.join('\n');
    }

    static formatAITaskResult(result: AITaskResult): string {
        const out: string[] = [];
        const status = result.success ? chalk.green('SUCCESS') : chalk.red('FAILED');
        const confidence = (result.confidence * 100).toFixed(0) + '%';
        
        out.push(`  ${status} — Confidence: ${confidence}`);
        if (!result.success && result.validationErrors.length > 0) {
            out.push(chalk.red(`    Errors: ${result.validationErrors.join(', ')}`));
        }
        if (result.explanation) {
            out.push(chalk.gray(`    Explanation: ${result.explanation}`));
        }
        return out.join('\n');
    }

    static formatMindMap(modules: Map<string, string[]>, activeFiles: Set<string>): string {
        const out: string[] = [];
        out.push('');
        out.push(chalk.bold('Codebase OS — Project Mind Map'));
        out.push(chalk.gray('─'.repeat(70)));

        const icons: Record<string, string> = {
            src: '📦',
            core: '⚙️',
            cli: '⌨️',
            api: '🌐',
            storage: '💾',
            utils: '🛠️',
            types: '🧬',
            diagnostics: '🔍'
        };

        const sortedModules = Array.from(modules.keys()).sort();
        for (const mod of sortedModules) {
            const files = modules.get(mod)!;
            const icon = icons[mod] ?? '📁';
            out.push(`${chalk.bold(icon + ' ' + mod.toUpperCase())}`);

            for (let i = 0; i < files.length; i++) {
                const f = files[i]!;
                const isLast = i === files.length - 1;
                const prefix = isLast ? ' └── ' : ' ├── ';
                const displayName = f.split(/[/\\]/).pop()!;
                
                let line = `${chalk.gray(prefix)}📄 ${displayName}`;
                if (activeFiles.has(f)) {
                    line = `${chalk.gray(prefix)}${chalk.cyan('🛠️ ' + displayName)} ${chalk.yellow('[PLANNED]')}`;
                }
                out.push(line);
            }
            out.push('');
        }

        return out.join('\n');
    }

    static formatGitStatus(status: { branch: string; staged: string[]; unstaged: string[]; untracked: string[]; ahead: number; behind: number }): string {
        const out: string[] = [];
        out.push('');
        out.push(chalk.bold(`Branch: ${chalk.cyan(status.branch)}`));
        if (status.ahead > 0) out.push(chalk.yellow(`  ${status.ahead} ahead of remote`));
        if (status.behind > 0) out.push(chalk.red(`  ${status.behind} behind remote`));
        out.push('');

        const table = new Table({ head: [chalk.cyan('Status'), chalk.cyan('File')], colWidths: [12, 60] });
        for (const f of status.staged) table.push([chalk.green('staged'), f]);
        for (const f of status.unstaged) table.push([chalk.yellow('modified'), f]);
        for (const f of status.untracked) table.push([chalk.gray('untracked'), f]);

        if (table.length > 0) out.push(table.toString());
        else out.push(chalk.green('  Working tree is clean.'));

        return out.join('\n');
    }

    static formatExecutionTable(results: AITaskResult[]): string {
        const out: string[] = [];
        out.push('');
        out.push(chalk.bold('AI Execution Summary'));
        out.push(chalk.gray('─'.repeat(80)));

        const table = new Table({
            head: [
                chalk.cyan('File'),
                chalk.cyan('Purpose'),
                chalk.cyan('Status'),
                chalk.cyan('Confidence'),
                chalk.cyan('Compiled'),
            ],
            colWidths: [30, 30, 15, 12, 12],
            wordWrap: true,
        });

        for (const r of results) {
            const rel = r.filePath.split(/[/\\]/).slice(-2).join('/');
            const status = r.success 
                ? chalk.green('APPLIED') 
                : r.confidence === 0 ? chalk.gray('SKIPPED') : chalk.red('FAILED');
            
            const compiled = r.success 
                ? chalk.green('YES') 
                : (r.validationErrors.length > 0 ? chalk.red('NO') : chalk.gray('-'));

            table.push([
                rel,
                r.explanation || 'Updated logic',
                status,
                (r.confidence * 100).toFixed(0) + '%',
                compiled
            ]);
        }

        out.push(table.toString());
        return out.join('\n');
    }

    static severityColor(severity: string): chalk.Chalk {
        switch (severity) {
            case 'breaking': return chalk.bgRed.white;
            case 'major': return chalk.red;
            case 'minor': return chalk.yellow;
            default: return chalk.green;
        }
    }
}
