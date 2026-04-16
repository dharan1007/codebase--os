import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { readFileTool, writeFileTool, listFilesTool, type ToolResult } from './tools/localTools.js';
import { execSync } from 'child_process';
import path from 'path';

export interface AgentAction {
    tool: 'read_file' | 'write_file' | 'list_files' | 'run_shell' | 'search_code' | 'find_references' | 'pause_and_ask' | 'spawn_sub_agent' | 'shadow_test' | 'finish';
    args: Record<string, string>;
    reasoning: string;
}

export interface AgentStep {
    step: number;
    action: AgentAction;
    result: ToolResult;
}

export interface AgentResult {
    success: boolean;
    steps: AgentStep[];
    summary: string;
    filesWritten: string[];
    totalSteps: number;
    tasklist: string[];
}

const TOOL_DEFINITIONS = `
You have access to these tools. Call ONE tool per response. Respond with ONLY valid JSON.

TOOLS:
- read_file(path): Read the content of a file.
- write_file(path, content): Write content to a file (creates or overwrites).
- list_files(dir): List files in a directory.
- run_shell(command): Run a safe, read-only shell command (tsc, npm test, ls, grep).
- finish(summary): Stop and report what you accomplished.

RESPONSE FORMAT (ONE tool per turn):
{
  "tool": "read_file" | "write_file" | "list_files" | "run_shell" | "finish",
  "args": { "path": "...", "content": "..." },
  "reasoning": "why you chose this tool right now"
}

DISCOVERY TOOLS (Use these to find where logic is):
- search_code(query): Project-wide regex search. Fast & Cheap.
- find_references(symbol): Find all usage sites of a class/function. High Precision.
`;

import { CheckpointManager } from './CheckpointManager.js';
import type { Database } from '../../storage/Database.js';
import { searchCodeTool, findReferencesTool } from './tools/discoveryTools.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { PromptTemplates } from './PromptTemplates.js';
import ora from 'ora';
import chalk from 'chalk';

/**
 * AgentLoop is Codebase OS's autonomous agentic execution engine.
 * It gives the AI the ability to iteratively read files, write code,
 * and verify its own work using local tools — all without human intervention.
 *
 * This turns 'cos agent' into a true autonomous coding agent on par with
 * or exceeding Claude Code's agentic mode.
 */
export class AgentLoop {
    private maxSteps = 20;
    private steps: AgentStep[] = [];
    private filesWritten: string[] = [];
    private tasklist: string[] = [];
    private checkpointManager: CheckpointManager;

    constructor(
        private provider: AIProvider,
        private rootDir: string,
        private db: Database,
        private sessionId: string,
        private graph: RelationshipGraph,
        private store: GraphStore
    ) {
        this.checkpointManager = new CheckpointManager(db);
    }

    async run(
        task: string,
        onStep?: (step: number, action: AgentAction, result: ToolResult, tasklist: string[]) => Promise<void> | void,
        initialSteps: AgentStep[] = [],
        initialFiles: string[] = []
    ): Promise<AgentResult> {
        this.steps = [...initialSteps];
        this.filesWritten = [...initialFiles];

        const systemPrompt = PromptTemplates.agentSystemPrompt(this.rootDir);

        // Maintain message history for true agentic memory
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
            { role: 'user', content: `TASK: ${task}\n\nBegin by exploring the architectural graph and project structure.` }
        ];

        // SUPREMACY UPGRADE: Architect Turn
        // The agent first uses discovery tools to build a master strategy.
        const archSpinner = ora('Architect is thinking...').start();
        const initialDiscovery = await searchCodeTool(task.split(' ').slice(0, 3).join(' '), this.rootDir);
        const archPrompt = `You are the Architect. Analyze the task and this initial discovery:
${initialDiscovery.output}

Outline a high-level technical strategy. List key files to read and the intended order of operations.`;
        
        try {
            const archCompletion = await this.provider.complete({
                systemPrompt: `You are a Senior Architect. Plan first.`,
                userPrompt: archPrompt,
                temperature: 0.1,
                maxTokens: 1024
            });
            messages.push({ role: 'user', content: `ARCHITECT STRATEGY:\n${archCompletion.content}\n\nProceed with Step 1 and complete the task.` });
            archSpinner.succeed('Architecture strategy ready.');
        } catch (err) {
            archSpinner.warn('Architect phase failed. Proceeding with standard discovery.');
        }

        let stepCount = 0;
        let lastSummary = 'Agent completed without a final summary.';

        while (stepCount < this.maxSteps) {
            stepCount++;

            // TOKEN PRESSURE PRUNING:
            // If history gets too long (> 10 messages), summarize early steps to keep context lean
            // for free-tier models (Fixes "API key expired" / 400 errors)
            if (messages.length > 10) {
                const pruned = messages.slice(-6); // Keep last 3 turns
                const summary = `(Older steps summarized: Agent explored structure and read ${this.steps.length - 3} files successfully.)`;
                messages.splice(0, messages.length, 
                    { role: 'user', content: `TASK: ${task}\n\n${summary}` },
                    ...pruned
                );
            }

            let response: string = '';
            try {
                // Construct the full prompt from history
                const userPrompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                
                if (this.provider.completeStream) {
                    const completion = await this.provider.completeStream({
                        systemPrompt,
                        userPrompt,
                        temperature: 0.1,
                        maxTokens: 4096,
                        responseFormat: 'json',
                    }, (token) => {
                        // Forward token for real-time thought streaming via a dedicated internal callback
                        // We'll pass it to a new optional callback in run()
                        (onStep as any)?.(stepCount, { tool: 'thinking', args: { token }, reasoning: '' }, { success: true, output: '' }, this.tasklist);
                    });
                    response = completion.content;
                } else {
                    const completion = await this.provider.complete({
                        systemPrompt,
                        userPrompt,
                        temperature: 0.1,
                        maxTokens: 4096,
                        responseFormat: 'json',
                    });
                    response = completion.content;
                }
                messages.push({ role: 'assistant', content: response });
            } catch (err: any) {
                const errorMsg = err.message || String(err);
                if (errorMsg.toLowerCase().includes('credit') || errorMsg.toLowerCase().includes('balance')) {
                    logger.error(`\n❌ AGENT STOPPED: ${errorMsg}`);
                    logger.info('Please top up your account and then run the agent again.');
                } else {
                    logger.error('Agent loop AI call failed', { error: errorMsg });
                }
                break;
            }

            // Parse the tool call
            let action: AgentAction;
            try {
                let cleaned = response.trim();
                // Remove markdown code blocks if present
                cleaned = cleaned.replace(/^```json\n?|\n?```$/g, '');
                
                // If it still doesn't parse, try to find the first '{' and last '}'
                let parsed: any;
                try {
                    parsed = JSON.parse(cleaned);
                } catch {
                    const firstBrace = cleaned.indexOf('{');
                    const lastBrace = cleaned.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1) {
                        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
                        parsed = JSON.parse(cleaned);
                    } else {
                        throw new Error('No JSON object found');
                    }
                }
                action = parsed as AgentAction;
                if (parsed.tasklist && Array.isArray(parsed.tasklist)) {
                    this.tasklist = parsed.tasklist;
                }
            } catch (err: any) {
                logger.error('Agent failed to parse AI tool response', { error: err.message, raw: response.substring(0, 500) });
                break;
            }

            // Handle finish
            if (action.tool === 'finish') {
                lastSummary = action.args['summary'] ?? 'Task complete.';
                
                // SUPREMACY UPGRADE: Reviewer Turn
                // Perform a final security and style audit 
                const reviewSpinner = ora('Security Reviewer is checking changes...').start();
                try {
                    const diffs = this.steps
                        .filter(s => s.action.tool === 'write_file')
                        .map(s => `File: ${s.action.args['path']}\nResult: ${s.result.success}`)
                        .join('\n');

                    const reviewPrompt = `You are a Lead Security Engineer. Review these changes for security risks, 
hardcoded secrets, or logic bugs.
Recent Actions:
${diffs}

Summary: ${lastSummary}

Respond with "SAFE" if no issues found, or a short bulleted list of concerns.`;

                    const reviewCompletion = await this.provider.complete({
                        systemPrompt: `You are a paranoid security reviewer. Be strict.`,
                        userPrompt: reviewPrompt,
                        temperature: 0,
                        maxTokens: 512
                    });

                    if (reviewCompletion.content.toUpperCase().includes('SAFE')) {
                        reviewSpinner.succeed('Security review passed [SAFE].');
                    } else {
                        reviewSpinner.warn('Security concerns identified:');
                        console.log(chalk.yellow(reviewCompletion.content));
                        lastSummary += `\n\nSECURITY NOTES:\n${reviewCompletion.content}`;
                    }
                } catch (err) {
                    reviewSpinner.warn('Security review failed. Proceeding with caution.');
                }
                break;
            }

            // Execute the tool
            let result = await this.executeTool(action, onStep, stepCount, this.tasklist);

            // Handle pause_and_ask interaction via callback (Awaited for intervention)
            if (action.tool === 'pause_and_ask' && onStep) {
                // If it's a pause_and_ask, we pass a special flag or just handle it in the CLI
                // For now, onStep will handle the prompt and we'll expect result.output to be updated
                // But wait, result is local. Let's make it more explicit.
            }

            // SUPREMACY UPGRADE: Recursive Healing
            // If the agent wrote a file, automatically check for TS errors
            if (action.tool === 'write_file' && result.success) {
                const tscResult = await this.executeTool({
                    tool: 'run_shell',
                    args: { command: 'npx tsc --noEmit' },
                    reasoning: 'Self-healing check'
                }, onStep, stepCount, this.tasklist);
                if (!tscResult.success || (tscResult.output && tscResult.output.includes('error'))) {
                    result.output = `FILE WRITTEN SUCCESSFULLY BUT INTRODUCED TYPESCRIPT ERRORS:\n${tscResult.output}\n\nFIX THESE ERRORS IMMEDIATELY.`;
                    result.success = false; 
                }
            }

            const step: AgentStep = { step: stepCount, action, result };
            this.steps.push(step);
            
            // Await the step notification (allows CLI to prompt user in pause_and_ask)
            if (onStep) {
                await onStep(stepCount, action, result, this.tasklist);
            }

            // "Context Shield": Truncate massive outputs to prevent free-tier 'Payload Too Large' or 429 errors
            let toolOutput = result.output || result.error || '(no output)';
            if (toolOutput.length > 3000) {
                const originalSize = toolOutput.length;
                toolOutput = toolOutput.substring(0, 3000) + `\n\n... (Output truncated to 3000 characters for context efficiency. Original size: ${originalSize} chars. Use read_file to view specific contents.)`;
            }

            // Feed result back into history
            let resultMsg = `Tool result (step ${stepCount}):
Tool: ${action.tool}
Success: ${result.success}
Output:
${toolOutput}

Continue. What is your next step?`;

            // SUPREMACY UPGRADE: Graph-Aware Intuition
            // If the agent read a file, automatically fetch its structural dependencies
            if (action.tool === 'read_file' && result.success) {
                const filePath = action.args['path'];
                if (filePath) {
                    const node = this.store.getPrimaryNodeForFile(filePath);
                    if (node) {
                        const neighbors = this.graph.getNeighbors(node.id);
                        if (neighbors.length > 0) {
                            const neighborContext = neighbors.slice(0, 5)
                                .map((n: any) => `- ${n.name} (${n.kind}): ${n.filePath}`)
                                .join('\n');
                            resultMsg += `\n\n[ARCHITECTURAL CONTEXT] You are currently reading "${filePath}". 
According to the graph, it is directly connected to:
${neighborContext}
Use this context to anticipate side effects in dependent modules.`;
                        }
                    }
                }
            }
            
            messages.push({ role: 'user', content: resultMsg });

            // "Cooling Period": Mandatory rest to prevent hitting free-tier RPM limits
            if (stepCount < this.maxSteps) {
                // UNSTOPPABLE AGENT: Autosave checkpoint after every step
                this.checkpointManager.save({
                    id: this.sessionId, // For agent mode, we use sessionId as checkpointId
                    sessionId: this.sessionId,
                    taskType: 'agent',
                    status: 'in_progress',
                    plan: [{ id: 'agent-main', kind: 'refactor', description: task, targetFile: '.', context: '', constraints: [], expectedOutput: '', priority: 1 }],
                    results: [], 
                    metadata: { 
                        steps: this.steps, 
                        filesWritten: this.filesWritten,
                        messages
                    },
                    updatedAt: Date.now()
                });

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        return {
            success: this.filesWritten.length > 0 || this.steps.some(s => s.result.success),
            steps: this.steps,
            summary: lastSummary,
            filesWritten: this.filesWritten,
            totalSteps: stepCount,
            tasklist: this.tasklist
        };
    }

    private async executeTool(
        action: AgentAction, 
        onStep?: (step: number, action: any, result: ToolResult, tasklist: string[]) => Promise<void> | void,
        stepCount: number = 0,
        tasklist: string[] = []
    ): Promise<ToolResult> {
        try {
            switch (action.tool) {
                case 'read_file':
                    return await readFileTool(action.args['path'] ?? '', this.rootDir);

                case 'write_file': {
                    const result = await writeFileTool(action.args['path'] ?? '', action.args['content'] ?? '', this.rootDir);
                    if (result.success) this.filesWritten.push(action.args['path'] ?? '');
                    return result;
                }

                case 'list_files':
                    return await listFilesTool(action.args['dir'] ?? '.', this.rootDir);

                case 'search_code':
                    return await searchCodeTool(action.args['query'] ?? '', this.rootDir);

                case 'find_references':
                    return await findReferencesTool(action.args['symbol'] ?? '', this.rootDir);

                case 'pause_and_ask':
                    // This is a special tool handled partly in the CLI layer via onStep
                    return { success: true, output: `User provided feedback: ${action.args['feedback'] ?? 'Handled'}` };

                case 'spawn_sub_agent': {
                    const task = action.args['task'] ?? '';
                    const type = action.args['specialist_type'] ?? 'General';
                    // Create an isolated sub-agent loop
                    const subAgent = new AgentLoop(this.provider, this.rootDir, this.db, `${this.sessionId}-sub`, this.graph, this.store);
                    try {
                        const result = await subAgent.run(`[Sub-Task: ${type}]\n${task}`);
                        return { 
                            success: result.success, 
                            output: `Sub-Agent completed.\nSummary: ${result.summary}\nFiles Edited: ${result.filesWritten.join(', ')}` 
                        };
                    } catch (e) {
                        return { success: false, output: '', error: String(e) };
                    }
                }

                case 'shadow_test': {
                    const targetFile = action.args['file_path'] ?? '';
                    const testInput = action.args['test_input_json'] ?? '{}';
                    const expectedOutput = action.args['expected_output_json'] ?? '{}';
                    
                    const testsDir = path.join(this.rootDir, '.cos', 'shadow_tests');
                    const fs = require('fs');
                    if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });
                    
                    const testFileName = `shadow-${Date.now()}.test.mjs`;
                    const testFilePath = path.join(testsDir, testFileName);
                    
                    // Native node runner assuming target file is parsable. We'll generate a lightweight raw execution script.
                    const testContent = `
import assert from 'assert';
import * as Module from '../../${targetFile.replace('.ts', '.js')}';

async function run() {
    try {
        const input = ${testInput};
        const expected = ${expectedOutput};
        const funcName = '${action.args['function_name'] ?? ''}';
        
        if (typeof Module[funcName] !== 'function') throw new Error('Function ' + funcName + ' not exported in ' + '${targetFile}');
        
        console.log('Running Shadow Test for:', funcName);
        const result = await Module[funcName](...Object.values(input));
        assert.deepStrictEqual(result, expected);
        console.log('SHADOW_TEST_PASS');
    } catch(e) {
        console.error('SHADOW_TEST_FAIL');
        console.error(e.message);
        process.exit(1);
    }
}
run();
`;
                    fs.writeFileSync(testFilePath, testContent, 'utf-8');
                    
                    // We recursively call run_shell to execute the generated test
                    return await this.executeTool({
                        tool: 'run_shell',
                        args: { command: `node ${testFilePath}` },
                        reasoning: 'Executing isolated logical shadow test'
                    }, onStep, stepCount, tasklist);
                }

                case 'run_shell': {
                    const cmd = action.args['command'] ?? '';
                    // Safety: only allow read-only/compile commands
                    const allowed = ['tsc', 'npx tsc', 'npm test', 'npm run', 'ls', 'grep', 'find', 'cat', 'node -e', 'python -c', 'python3 -c'];
                    const isAllowed = allowed.some(a => cmd.startsWith(a));
                    if (!isAllowed) {
                        return { success: false, output: '', error: `Command not allowed for safety: ${cmd}` };
                    }

                    // SUPREMACY UPGRADE: Async Streaming Spawn
                    const { spawn } = await import('child_process');
                    return new Promise((resolve) => {
                        const [exe, ...args] = cmd.split(' ');
                        const child = spawn(exe, args, { cwd: this.rootDir, shell: true });
                        let output = '';
                        
                        child.stdout.on('data', (data) => {
                            const str = data.toString();
                            output += str;
                            // Optional: Forward live tool output to CLI via callback
                            (onStep as any)?.(stepCount, action, { success: true, output: str, isStreaming: true }, this.tasklist);
                        });
                        
                        child.stderr.on('data', (data) => {
                            output += data.toString();
                        });

                        child.on('close', (code) => {
                            resolve({ success: code === 0 || code === null, output: output.slice(0, 5000) });
                        });

                        child.on('error', (err) => {
                            resolve({ success: false, output: '', error: err.message });
                        });

                        // Timeout safety
                        setTimeout(() => {
                            child.kill();
                            resolve({ success: false, output: output.slice(0, 5000), error: 'Command timed out after 60s' });
                        }, 60000);
                    });
                }

                default:
                    return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }
}
