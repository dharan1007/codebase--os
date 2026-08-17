import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { loadContext } from '../context.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import { SessionMemory } from '../../core/context/SessionMemory.js';

const TOOL_LABEL: Record<string, string> = {
    write_file: 'WRITE',
    patch_file: 'PATCH',
    read_file: 'READ',
    list_files: 'LIST',
    search_code: 'SEARCH',
    find_references: 'REFS',
    run_shell: 'SHELL',
    delete_file: 'DELETE',
    move_file: 'MOVE',
    finish: 'DONE',
};

function renderStep(step: number, action: any, result: any, diff?: string): void {
    const label = TOOL_LABEL[action.tool] ?? String(action.tool || 'TOOL').toUpperCase();
    const target = action.args?.path || action.args?.oldPath || action.args?.command || action.args?.dir || '';
    const status = result.success ? chalk.green('OK') : chalk.red('FAIL');
    console.log(`  ${chalk.gray(`[${step}]`)} ${chalk.cyan(label.padEnd(8))} ${chalk.white(target)} ${status}`);

    if (action.reasoning) {
        const reasoning = String(action.reasoning);
        console.log(chalk.gray(`         ${reasoning.length > 100 ? `${reasoning.slice(0, 100)}...` : reasoning}`));
    }
    if (!result.success && result.error) {
        console.log(chalk.red(`         ${String(result.error).slice(0, 180)}`));
    }
    if (diff) {
        for (const line of diff.split('\n').slice(0, 30)) {
            if (line.startsWith('+') && !line.startsWith('+++')) console.log(chalk.green(`         ${line}`));
            else if (line.startsWith('-') && !line.startsWith('---')) console.log(chalk.red(`         ${line}`));
            else if (line.startsWith('@@')) console.log(chalk.cyan(`         ${line}`));
        }
    }
}

export function chatCommand(): Command {
    return new Command('chat')
        .description('Interactive coding session backed by the verified AgentLoop runtime')
        .option('--max-turns <n>', 'Maximum autonomous steps for each user message', '30')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, graph, store, aiProvider } = ctx;
            const rootDir = config.rootDir;
            const maxTurns = Math.min(100, Math.max(1, Number.parseInt(String(opts.maxTurns), 10) || 30));
            const conversationSummaries: string[] = [];

            const memory = new SessionMemory(db, rootDir).load(5);
            console.log('');
            console.log(chalk.bold('Codebase OS — Verified Interactive Session'));
            console.log(chalk.gray('─'.repeat(60)));
            console.log(`  Project : ${chalk.cyan(config.name)}`);
            console.log(`  Provider: ${chalk.cyan(config.ai.provider)}/${chalk.white(config.ai.model ?? 'semantic default')}`);
            console.log(`  Graph   : ${chalk.gray(graph.nodes.size > 0 ? `${graph.nodes.size} nodes` : 'not scanned')}`);
            console.log(`  Memory  : ${chalk.gray(memory.totalChanges > 0 ? `${memory.totalChanges} recorded changes` : 'fresh project')}`);
            console.log(`  Safety  : ${chalk.gray('all mutations use the same transactional, sandboxed, independently verified AgentLoop as cos agent')}`);
            console.log(chalk.gray('─'.repeat(60)));
            console.log(chalk.gray('  Commands: /clear  /plan <task>  /exit'));
            console.log('');

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: process.stdin.isTTY,
            });

            const ask = (): void => {
                rl.question(chalk.cyan('you  ') + chalk.gray('> '), input => {
                    void processInput(input.trim()).finally(() => {
                        if (!rl.closed) ask();
                    });
                });
            };

            const processInput = async (input: string): Promise<void> => {
                if (!input) return;
                if (input === '/exit' || input === '/quit') {
                    rl.close();
                    return;
                }
                if (input === '/clear') {
                    conversationSummaries.length = 0;
                    console.log(chalk.gray('  Conversational summaries cleared. Durable project evidence is unchanged.\n'));
                    return;
                }
                if (input.startsWith('/plan')) {
                    const task = input.replace(/^\/plan\s*/, '').trim();
                    if (!task) {
                        console.log(chalk.yellow('  Usage: /plan <task>\n'));
                        return;
                    }
                    if (graph.nodes.size === 0) {
                        console.log(chalk.yellow('  Graph is empty. Run cos scan first.\n'));
                        return;
                    }
                    const report = new TopologicalPlanner(graph, rootDir).planFromTask(task);
                    console.log(chalk.bold(`\n  Affected files: ${report.totalFiles}`));
                    for (const file of report.affectedFiles.slice(0, 30)) {
                        console.log(`  ${chalk.gray(`[${file.executionOrder}]`)} ${chalk.cyan(file.relativePath)} ${chalk.gray(`[${file.layer}] ${file.reason}`)}`);
                    }
                    if (report.cycles.length > 0) {
                        console.log(chalk.red('  Dependency cycles:'));
                        report.cycles.forEach(cycle => console.log(chalk.red(`    ${cycle}`)));
                    }
                    console.log('');
                    return;
                }

                const priorContext = conversationSummaries.length > 0
                    ? `\n\nRECENT CONVERSATION OUTCOMES (context only; verify against repository state):\n${conversationSummaries.slice(-6).join('\n')}`
                    : '';
                const task = `${input}${priorContext}`;
                const sessionId = uuidv4();
                const agent = new AgentLoop(aiProvider, rootDir, db, sessionId, graph, store);

                const result = await agent.run(task, {
                    maxSteps: maxTurns,
                    onStep: async (step, action, toolResult, _tasklist, diff) => {
                        if (toolResult.isStreaming) {
                            process.stdout.write(chalk.gray(String(toolResult.output || '')));
                            return;
                        }
                        renderStep(step, action, toolResult, diff);
                    },
                });

                console.log('');
                if (result.success) {
                    console.log(chalk.green.bold('  VERIFIED'));
                } else if (result.verified) {
                    console.log(chalk.yellow.bold('  VERIFIED STATE, TASK INCOMPLETE'));
                } else {
                    console.log(chalk.yellow.bold('  NOT VERIFIED / INCOMPLETE'));
                }
                console.log(`  ${result.summary}`);
                if (result.verificationCommands.length > 0) {
                    console.log(chalk.gray(`  Evidence: ${result.verificationCommands.join(' | ')}`));
                }
                if (result.filesWritten.length > 0) {
                    console.log(chalk.gray(`  Affected: ${result.filesWritten.map(file => path.relative(rootDir, path.resolve(rootDir, file))).join(', ')}`));
                }
                console.log('');

                conversationSummaries.push(
                    `- User request: ${input.slice(0, 500)} | Runtime result: ${result.success ? 'verified success' : 'incomplete'} | ${result.summary.slice(0, 700)}`,
                );
                if (conversationSummaries.length > 8) conversationSummaries.splice(0, conversationSummaries.length - 8);
            };

            rl.on('close', () => {
                console.log(chalk.gray('\nSession ended.\n'));
            });

            ask();
        });
}
