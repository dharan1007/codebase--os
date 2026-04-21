import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import readline from 'readline';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { PromptTemplates } from '../../core/ai/PromptTemplates.js';
import { extractJSONFromAIOutput, validateAgentAction } from '../../utils/validation.js';
import { SessionMemory } from '../../core/context/SessionMemory.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import {
    readFileTool,
    writeFileTool,
    patchFileTool,
    deleteFileTool,
    moveFileTool,
    listFilesTool,
} from '../../core/ai/tools/localTools.js';
import { searchCodeTool, findReferencesTool } from '../../core/ai/tools/discoveryTools.js';
import { SandboxManager } from '../../core/sandbox/SandboxManager.js';
import { computeDiff } from '../../utils/diff.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

// ─── ANSI raw terminal rendering ─────────────────────────────────────────────

function clearLine() {
    process.stdout.write('\r\x1b[K');
}

function renderDiffLine(line: string): void {
    if (line.startsWith('@@'))       process.stdout.write(chalk.cyan(line) + '\n');
    else if (line.startsWith('+') && !line.startsWith('+++')) process.stdout.write(chalk.green(line) + '\n');
    else if (line.startsWith('-') && !line.startsWith('---')) process.stdout.write(chalk.red(line) + '\n');
    else if (line.startsWith('---') || line.startsWith('+++')) { /* skip file headers */ }
    else process.stdout.write(chalk.gray(line) + '\n');
}

function renderDiff(oldContent: string, newContent: string, filePath: string): void {
    const diff = computeDiff(oldContent, newContent, filePath);
    if (!diff.raw || diff.raw.trim() === '') return;
    diff.raw.split('\n').slice(0, 40).forEach(renderDiffLine);
    const total = diff.raw.split('\n').length;
    if (total > 40) process.stdout.write(chalk.gray(`  ... ${total - 40} more lines\n`));
}

const TOOL_LABEL: Record<string, string> = {
    write_file:      'WRITE',
    patch_file:      'PATCH',
    read_file:       'READ',
    list_files:      'LIST',
    search_code:     'SEARCH',
    find_references: 'REFS',
    run_shell:       'SHELL',
    delete_file:     'DELETE',
    move_file:       'MOVE',
    finish:          'DONE',
};

export function chatCommand(): Command {
    return new Command('chat')
        .description('Interactive coding session — persistent multi-turn conversation with graph context')
        .option('--model <model>', 'Override the AI model (e.g. claude-3-5-sonnet-latest)')
        .option('--max-turns <n>', 'Max agent turns per message', '20')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, sessionId, graph, store } = ctx;
            const rootDir = config.rootDir;

            let provider;
            try {
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`Provider error: ${String(err)}`));
                process.exit(1);
            }

            const sandbox = new SandboxManager(rootDir);

            // ─── Session bootstrap ──────────────────────────────────────────
            const memory = new SessionMemory(db, rootDir);
            const mem = memory.load(3);

            // Build the persistent conversation messages array
            const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

            // Seed with session memory + project structure
            let dirOut = await listFilesTool('.', rootDir);
            const projectSnapshot =
                `PROJECT ROOT: ${rootDir}\n\n` +
                `PROJECT STRUCTURE:\n${dirOut.output.split('\n').slice(0, 60).join('\n')}\n\n` +
                (mem.formatted ? `${mem.formatted}\n\n` : '') +
                (graph.nodes.size > 0
                    ? `GRAPH: ${graph.nodes.size} nodes, ${graph.edges.size} edges indexed.\n`
                    : 'GRAPH: Not scanned yet (run cos scan for graph intelligence).\n');

            conversationHistory.push({
                role: 'user',
                content: `[CONTEXT SNAPSHOT — do not respond to this, just absorb it]\n${projectSnapshot}`,
            });
            conversationHistory.push({
                role: 'assistant',
                content: JSON.stringify({
                    tool: 'finish',
                    args: { summary: 'Context absorbed. Ready.' },
                    reasoning: 'Absorbing project context.',
                }),
            });

            // ─── UI ────────────────────────────────────────────────────────
            const printHeader = () => {
                console.log('');
                console.log(chalk.bold('Codebase OS — Interactive Chat'));
                console.log(chalk.gray('─'.repeat(56)));
                console.log(`  Project : ${chalk.cyan(config.name)}`);
                console.log(`  Provider: ${chalk.cyan(config.ai.provider)}/${chalk.white(config.ai.model ?? 'default')}`);
                console.log(`  Graph   : ${chalk.gray(graph.nodes.size > 0 ? `${graph.nodes.size} nodes` : 'not scanned')}`);
                console.log(`  Memory  : ${chalk.gray(mem.totalChanges > 0 ? `${mem.totalChanges} changes across ${mem.pastSessions.length} sessions` : 'fresh project')}`);
                console.log(chalk.gray('─'.repeat(56)));
                console.log(chalk.gray('  Type your request. Commands: /clear  /plan <task>  /exit'));
                console.log('');
            };

            printHeader();

            // Track files written this session for context
            const sessionFiles = new Map<string, string>(); // path → original content
            let turnCount = 0;

            // ─── Core agent loop for a single user message ─────────────────
            const processUserMessage = async (userInput: string): Promise<void> => {
                if (!userInput.trim()) return;

                // ── slash commands ────────────────────────────────────────
                if (userInput.trim() === '/exit' || userInput.trim() === '/quit') {
                    console.log(chalk.gray('\nSession ended.\n'));
                    process.exit(0);
                }

                if (userInput.trim() === '/clear') {
                    conversationHistory.splice(2); // keep seed messages
                    console.log(chalk.gray('  Context cleared (project snapshot kept).\n'));
                    return;
                }

                if (userInput.trim().startsWith('/plan')) {
                    const task = userInput.trim().replace('/plan', '').trim() || 'current task';
                    if (graph.nodes.size === 0) {
                        console.log(chalk.yellow('  Graph not scanned. Run cos scan first.\n'));
                        return;
                    }
                    const planner = new TopologicalPlanner(graph, rootDir);
                    const report = planner.planFromTask(task);
                    if (report.totalFiles === 0) {
                        console.log(chalk.gray('  No affected files found in graph for this task.\n'));
                        return;
                    }
                    console.log(chalk.bold(`\n  Blast radius: ${report.totalFiles} files`));
                    for (const f of report.affectedFiles) {
                        const hub = f.dependentCount >= 5 ? chalk.red(` [hub: ${f.dependentCount} deps]`) : '';
                        console.log(`  ${chalk.gray(`[${f.executionOrder}]`)} ${chalk.cyan(f.relativePath)} ${chalk.gray(`[${f.layer}]`)}${hub}`);
                    }
                    console.log('');
                    return;
                }

                // ── normal message — push to history ──────────────────────
                conversationHistory.push({ role: 'user', content: userInput });

                const systemPrompt = PromptTemplates.agentSystemPrompt(rootDir);
                const maxTurns = parseInt(opts.maxTurns, 10) || 20;
                let agentTurns = 0;
                let lastSummary = '';
                let hasResponded = false;

                // ── agent execution loop ───────────────────────────────────
                while (agentTurns < maxTurns) {
                    agentTurns++;

                    const prompt = conversationHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

                    let rawResponse = '';
                    try {
                        const res = await provider.execute({
                            taskType: 'reasoning',
                            priority: 'high',
                            context: prompt,
                            systemPrompt,
                            maxTokens: 4000,
                        });
                        rawResponse = res.content;
                    } catch (err: any) {
                        console.log(chalk.red(`  Provider error: ${err.message}`));
                        break;
                    }

                    conversationHistory.push({ role: 'assistant', content: rawResponse });

                    // Parse + validate
                    let action: any;
                    try {
                        const raw = extractJSONFromAIOutput(rawResponse);
                        action = validateAgentAction(raw, rootDir);
                    } catch (err: any) {
                        // AI gave a plain text answer — display it directly
                        const isPlainText = !rawResponse.trim().startsWith('{');
                        if (isPlainText) {
                            console.log('');
                            console.log(chalk.white(rawResponse.trim()));
                            console.log('');
                            hasResponded = true;
                            break;
                        }

                        conversationHistory.push({
                            role: 'user',
                            content: `[CORRECTION]: ${err.message}\nOutput valid JSON only. No markdown. No prose. Just the JSON action.`,
                        });
                        continue;
                    }

                    const tool: string = action.tool;
                    const args: Record<string, string> = action.args ?? {};
                    const reasoning: string = action.reasoning ?? '';

                    if (tool === 'finish') {
                        lastSummary = args['summary'] ?? 'Done.';
                        // Print the summary as a plain response
                        console.log('');
                        console.log(chalk.white(lastSummary));
                        console.log('');
                        hasResponded = true;
                        break;
                    }

                    // Print step line
                    const toolLabel = TOOL_LABEL[tool] ?? tool.toUpperCase();
                    const target = args['path'] || args['command'] || args['dir'] || args['symbol'] || '';
                    const toolColor: Record<string, chalk.Chalk> = {
                        WRITE: chalk.green, PATCH: chalk.cyan, READ: chalk.gray,
                        SHELL: chalk.yellow, DELETE: chalk.red, DONE: chalk.green,
                    };
                    const labelFn = toolColor[toolLabel] ?? chalk.white;
                    process.stdout.write(`  ${chalk.gray(`[${agentTurns}]`)} ${labelFn(toolLabel.padEnd(8))} ${chalk.white(target)}\n`);

                    if (reasoning) {
                        const short = reasoning.length > 90 ? reasoning.slice(0, 90) + '...' : reasoning;
                        process.stdout.write(`         ${chalk.gray(short)}\n`);
                    }

                    // Execute tool
                    let toolResult: any;
                    try {
                        switch (tool) {
                            case 'read_file':
                                toolResult = await readFileTool(args['path'] ?? '', rootDir);
                                break;
                            case 'write_file': {
                                const fp = args['path'] ?? '';
                                const absPath = path.isAbsolute(fp) ? fp : path.resolve(rootDir, fp);
                                const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
                                if (!sessionFiles.has(fp)) sessionFiles.set(fp, oldContent);
                                toolResult = await writeFileTool(fp, args['content'] ?? '', rootDir);
                                if (toolResult.success) {
                                    renderDiff(oldContent, args['content'] ?? '', fp);
                                }
                                break;
                            }
                            case 'patch_file': {
                                const fp = args['path'] ?? '';
                                toolResult = await patchFileTool(fp, args['diff'] ?? '', rootDir);
                                if (toolResult.success && args['diff']) {
                                    args['diff'].split('\n').forEach(renderDiffLine);
                                }
                                break;
                            }
                            case 'delete_file':
                                toolResult = await deleteFileTool(args['path'] ?? '', rootDir);
                                break;
                            case 'move_file':
                                toolResult = await moveFileTool(args['oldPath'] ?? '', args['newPath'] ?? '', rootDir);
                                break;
                            case 'list_files':
                                toolResult = await listFilesTool(args['dir'] ?? '.', rootDir);
                                break;
                            case 'search_code':
                                toolResult = await searchCodeTool(args['query'] ?? '', rootDir);
                                break;
                            case 'find_references':
                                toolResult = await findReferencesTool(args['symbol'] ?? '', rootDir);
                                break;
                            case 'run_shell':
                                toolResult = await sandbox.execute(args['command'] ?? '', false, (chunk) => {
                                    process.stdout.write(chalk.gray(chunk));
                                });
                                break;
                            case 'pause_and_ask': {
                                const question = args['feedback'] ?? 'Need your input:';
                                console.log('');
                                process.stdout.write(chalk.yellow(`  ? ${question} `));
                                // Temporarily close readline, get input, reopen
                                const answer = await new Promise<string>((resolve) => {
                                    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
                                    rl2.once('line', (line) => { rl2.close(); resolve(line); });
                                });
                                toolResult = { success: true, output: answer };
                                break;
                            }
                            default:
                                toolResult = { success: false, output: '', error: `Unknown tool: ${tool}` };
                        }
                    } catch (err: any) {
                        toolResult = { success: false, output: '', error: err.message };
                    }

                    // Status indicator
                    process.stdout.write(
                        toolResult.success
                            ? chalk.green('          OK\n')
                            : chalk.red(`          FAIL: ${(toolResult.error ?? '').slice(0, 80)}\n`)
                    );

                    // Inject tool result back into conversation
                    const toolMsg =
                        `[TOOL RESULT: ${tool}]\n` +
                        `Status: ${toolResult.success ? 'SUCCESS' : 'FAILED'}\n` +
                        `Output: ${(toolResult.output || toolResult.error || 'empty').slice(0, 800)}`;
                    conversationHistory.push({ role: 'user', content: toolMsg });
                }

                process.stdout.write('\n');
                turnCount++;
            };

            // ─── REPL Loop ─────────────────────────────────────────────────
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: process.stdin.isTTY,
            });

            const prompt = () => {
                rl.question(chalk.cyan('you  ') + chalk.gray('> '), async (input) => {
                    await processUserMessage(input.trim());
                    prompt();
                });
            };

            prompt();

            rl.on('close', () => {
                console.log(chalk.gray('\nSession ended.\n'));
                process.exit(0);
            });
        });
}
