import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import { patchFileTool } from '../../core/ai/tools/localTools.js';
import type { AIProvider } from '../../types/index.js';
import type { ProjectConfig } from '../../types/index.js';
import type { RelationshipGraph } from '../../core/graph/RelationshipGraph.js';

interface PropagationTarget {
    relativePath: string;
    absolutePath: string;
    layer: string;
    reason: string;
    dependentCount: number;
}

const IGNORE = ['node_modules', '.git', 'dist', '.cos', 'coverage', '__pycache__', '*.min.js'];

function shouldIgnore(filePath: string): boolean {
    return IGNORE.some(ig => filePath.includes(ig));
}

/**
 * Computes a surgical patch for a downstream file that may have broken
 * due to changes in an upstream dependency.
 * Calls the AI to generate a targeted unified diff.
 */
async function generatePropagationPatch(
    provider: AIProvider,
    config: ProjectConfig,
    changedFile: string,
    changedContent: string,
    targetFile: string,
    targetContent: string
): Promise<string | null> {
    const changedRel = path.relative(config.rootDir, changedFile).replace(/\\/g, '/');
    const targetRel = path.relative(config.rootDir, targetFile).replace(/\\/g, '/');

    const prompt =
        `[PROPAGATION TASK]\n` +
        `A file was modified. Determine if a downstream file needs to be updated.\n\n` +
        `CHANGED FILE: ${changedRel}\n` +
        `NEW CONTENT (first 200 lines):\n${changedContent.split('\n').slice(0, 200).join('\n')}\n\n` +
        `DOWNSTREAM FILE: ${targetRel}\n` +
        `CURRENT CONTENT:\n${targetContent.split('\n').slice(0, 200).join('\n')}\n\n` +
        `TASK: If the downstream file needs to be updated to remain consistent with the changed file ` +
        `(e.g., interface changes, signature changes, import changes, type changes), ` +
        `output a unified diff for the downstream file. ` +
        `If no changes are needed, output the single word: NO_CHANGE\n\n` +
        `Output ONLY a unified diff in this format:\n` +
        `@@ -<oldStart>,<count> +<newStart>,<count> @@\n` +
        ` context line\n` +
        `-removed line\n` +
        `+added line\n\n` +
        `If no changes needed: output exactly: NO_CHANGE`;

    try {
        const result = await provider.execute({
            taskType: 'reasoning',
            priority: 'medium',
            context: prompt,
            systemPrompt:
                `You are a precise code synchronization engine. ` +
                `Analyze if a downstream file needs to be patched after an upstream file changed. ` +
                `Output ONLY a unified diff or the word NO_CHANGE. Nothing else.`,
            maxTokens: 2000,
        });

        const content = result.content.trim();
        if (content === 'NO_CHANGE' || !content.includes('@@')) return null;

        // Extract just the diff portion
        const diffStart = content.indexOf('@@');
        if (diffStart === -1) return null;
        return content.slice(diffStart);
    } catch {
        return null;
    }
}

export function propagateCommand(): Command {
    return new Command('propagate')
        .description('Watch files and auto-propagate changes to downstream dependents (unique to Codebase OS)')
        .option('--auto', 'Auto-apply patches without asking (use with caution)')
        .option('--dry-run', 'Show what would be patched but do not apply')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph } = ctx;
            const rootDir = config.rootDir;

            if (graph.nodes.size === 0) {
                console.log(chalk.yellow('\n  Graph is empty. Run cos scan first to enable propagation.\n'));
                return;
            }

            let provider: AIProvider;
            try {
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`Provider error: ${String(err)}`));
                process.exit(1);
            }

            const planner = new TopologicalPlanner(graph, rootDir);

            // Track previous file contents for change detection
            const prevContents = new Map<string, string>();
            const processing = new Set<string>();

            console.log('');
            console.log(chalk.bold('Codebase OS — Active Propagation Guard'));
            console.log(chalk.gray('─'.repeat(56)));
            console.log(`  Project : ${chalk.cyan(config.name)}`);
            console.log(`  Graph   : ${chalk.cyan(graph.nodes.size + ' nodes, ' + graph.edges.size + ' edges')}`);
            console.log(`  Mode    : ${opts.auto ? chalk.yellow('AUTO-APPLY') : opts.dryRun ? chalk.gray('DRY RUN') : chalk.cyan('INTERACTIVE')}`);
            console.log(chalk.gray('─'.repeat(56)));
            console.log(chalk.gray('  Save any file to trigger blast radius analysis and auto-patch.'));
            console.log(chalk.gray('  Press Ctrl+C to stop.'));
            console.log('');

            const watcher = chokidar.watch(rootDir, {
                ignored: (filePath: string) => shouldIgnore(filePath),
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
            });

            const handleChange = async (absPath: string, eventType: string): Promise<void> => {
                if (processing.has(absPath)) return;
                if (shouldIgnore(absPath)) return;

                const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
                const ext = path.extname(absPath);
                const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.c', '.cpp'];
                if (!codeExtensions.includes(ext)) return;

                processing.add(absPath);

                try {
                    let newContent = '';
                    try {
                        newContent = fs.readFileSync(absPath, 'utf8');
                    } catch {
                        processing.delete(absPath);
                        return;
                    }

                    const prevContent = prevContents.get(absPath) ?? '';
                    prevContents.set(absPath, newContent);

                    // Skip if content unchanged (e.g. just a touch)
                    if (newContent === prevContent) {
                        processing.delete(absPath);
                        return;
                    }

                    console.log(`${chalk.gray(new Date().toLocaleTimeString())} ${chalk.cyan('CHANGED')} ${chalk.white(relPath)}`);

                    // Compute blast radius
                    const report = planner.planFromFiles([absPath]);
                    const targets: PropagationTarget[] = report.affectedFiles
                        .filter(f => f.filePath !== absPath && f.filePath !== path.resolve(rootDir, relPath))
                        .slice(0, 12)
                        .map(f => ({
                            relativePath: f.relativePath,
                            absolutePath: f.filePath,
                            layer: f.layer,
                            reason: f.reason,
                            dependentCount: f.dependentCount,
                        }));

                    if (targets.length === 0) {
                        console.log(chalk.gray('  No downstream dependents found in graph.\n'));
                        processing.delete(absPath);
                        return;
                    }

                    console.log(chalk.bold(`  Blast radius: ${targets.length} downstream file${targets.length > 1 ? 's' : ''} detected`));
                    for (const t of targets) {
                        const hub = t.dependentCount >= 5 ? chalk.red(` [hub:${t.dependentCount}]`) : '';
                        console.log(`    ${chalk.gray('-')} ${chalk.white(t.relativePath)} ${chalk.gray(`[${t.layer}]`)}${hub} ${chalk.gray(`(${t.reason})`)}`);
                    }
                    console.log('');

                    let shouldProcess = opts.auto || opts.dryRun;
                    if (!shouldProcess) {
                        const { confirm } = await inquirer.prompt([{
                            type: 'confirm',
                            name: 'confirm',
                            message: `  Analyze these ${targets.length} files for required updates?`,
                            default: true,
                        }]);
                        shouldProcess = confirm;
                    }

                    if (!shouldProcess) {
                        console.log(chalk.gray('  Skipped.\n'));
                        processing.delete(absPath);
                        return;
                    }

                    // For each downstream target, generate and apply patch
                    for (const target of targets) {
                        let targetContent = '';
                        try {
                            targetContent = fs.readFileSync(target.absolutePath, 'utf8');
                        } catch {
                            continue;
                        }

                        process.stdout.write(`  ${chalk.cyan('ANALYZING')} ${target.relativePath} ... `);

                        const diff = await generatePropagationPatch(
                            provider, config,
                            absPath, newContent,
                            target.absolutePath, targetContent
                        );

                        if (!diff) {
                            process.stdout.write(chalk.gray('no changes needed\n'));
                            continue;
                        }

                        process.stdout.write(chalk.green('patch generated\n'));

                        // Count hunk lines
                        const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
                        const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
                        console.log(chalk.gray(`    +${addedLines} -${removedLines} lines`));

                        if (opts.dryRun) {
                            diff.split('\n').slice(0, 20).forEach(line => {
                                if (line.startsWith('+') && !line.startsWith('+++')) console.log(chalk.green(`    ${line}`));
                                else if (line.startsWith('-') && !line.startsWith('---')) console.log(chalk.red(`    ${line}`));
                                else if (line.startsWith('@@')) console.log(chalk.cyan(`    ${line}`));
                            });
                            continue;
                        }

                        let shouldApply = opts.auto;
                        if (!shouldApply) {
                            const { apply } = await inquirer.prompt([{
                                type: 'confirm',
                                name: 'apply',
                                message: `  Apply patch to ${target.relativePath}?`,
                                default: true,
                            }]);
                            shouldApply = apply;
                        }

                        if (shouldApply) {
                            processing.add(target.absolutePath); // prevent re-trigger
                            const result = await patchFileTool(target.absolutePath, diff, rootDir);
                            if (result.success) {
                                console.log(chalk.green(`  Patched: ${target.relativePath}`));
                            } else {
                                console.log(chalk.red(`  Patch failed: ${result.error}`));
                            }
                            setTimeout(() => processing.delete(target.absolutePath), 1000);
                        }
                    }

                    console.log('');
                } finally {
                    setTimeout(() => processing.delete(absPath), 500);
                }
            };

            watcher.on('change', (p) => handleChange(p, 'change'));
            watcher.on('add', (p) => handleChange(p, 'add'));

            process.on('SIGINT', () => {
                console.log(chalk.gray('\nPropagation guard stopped.\n'));
                watcher.close();
                process.exit(0);
            });
        });
}
