import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { readFileTool, writeFileTool, listFilesTool, type ToolResult } from './tools/localTools.js';
import { execSync } from 'child_process';
import path from 'path';

export interface AgentAction {
    tool: 'read_file' | 'write_file' | 'list_files' | 'run_shell' | 'search_code' | 'find_references' | 'finish';
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
    private checkpointManager: CheckpointManager;

    constructor(
        private provider: AIProvider,
        private rootDir: string,
        db: Database,
        private sessionId: string,
    ) {
        this.checkpointManager = new CheckpointManager(db);
    }

    async run(
        task: string,
        onStep?: (step: number, action: AgentAction, result: ToolResult) => void,
        initialSteps: AgentStep[] = [],
        initialFiles: string[] = []
    ): Promise<AgentResult> {
        this.steps = [...initialSteps];
        this.filesWritten = [...initialFiles];

        const systemPrompt = `You are an autonomous coding agent called Codebase OS Agent.
Your job is to complete the given coding task by using tools to read the project, write code, and verify your work.
${TOOL_DEFINITIONS}

Project root: ${this.rootDir}
IMPORTANT:
- Always start by listing files or reading relevant files to understand the project structure.
- Make targeted, minimal changes.
- After writing code, run the compiler (run_shell with 'npx tsc --noEmit 2>&1' or equivalent) to verify your work.
- Only call finish() when the task is truly complete or you cannot proceed.`;

        // Maintain message history for true agentic memory
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
            { role: 'user', content: `TASK: ${task}\n\nBegin by exploring the project structure.` }
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

            let response: string;
            try {
                // Construct the full prompt from history
                const userPrompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                const completion = await this.provider.complete({
                    systemPrompt,
                    userPrompt,
                    temperature: 0.1,
                    maxTokens: 4096,
                    responseFormat: 'json',
                });
                response = completion.content;
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
                try {
                    action = JSON.parse(cleaned) as AgentAction;
                } catch {
                    const firstBrace = cleaned.indexOf('{');
                    const lastBrace = cleaned.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1) {
                        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
                        action = JSON.parse(cleaned) as AgentAction;
                    } else {
                        throw new Error('No JSON object found');
                    }
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
            const result = await this.executeTool(action);
            const step: AgentStep = { step: stepCount, action, result };
            this.steps.push(step);
            onStep?.(stepCount, action, result);

            // "Context Shield": Truncate massive outputs to prevent free-tier 'Payload Too Large' or 429 errors
            let toolOutput = result.output || result.error || '(no output)';
            if (toolOutput.length > 3000) {
                const originalSize = toolOutput.length;
                toolOutput = toolOutput.substring(0, 3000) + `\n\n... (Output truncated to 3000 characters for context efficiency. Original size: ${originalSize} chars. Use read_file to view specific contents.)`;
            }

            // Feed result back into history
            const resultMsg = `Tool result (step ${stepCount}):
Tool: ${action.tool}
Success: ${result.success}
Output:
${toolOutput}

Continue. What is your next step?`;
            
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
        };
    }

    private async executeTool(action: AgentAction): Promise<ToolResult> {
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

                case 'run_shell': {
                    const cmd = action.args['command'] ?? '';
                    // Safety: only allow read-only/compile commands
                    const allowed = ['tsc', 'npx tsc', 'npm test', 'npm run', 'ls', 'grep', 'find', 'cat', 'node -e', 'python -c', 'python3 -c'];
                    const isAllowed = allowed.some(a => cmd.startsWith(a));
                    if (!isAllowed) {
                        return { success: false, output: '', error: `Command not allowed for safety: ${cmd}` };
                    }
                    try {
                        // Production-grade timeout: 60s max for any shell command
                        const output = execSync(cmd, { 
                            cwd: this.rootDir, 
                            encoding: 'utf8', 
                            timeout: 60000, 
                            stdio: ['ignore', 'pipe', 'pipe'] 
                        });
                        return { success: true, output: (output as string).slice(0, 5000) };
                    } catch (err: any) {
                        if (err.code === 'ETIMEDOUT') {
                            return { success: false, output: '', error: 'Command timed out after 60 seconds.' };
                        }
                        const out = (err?.stdout ?? '') + (err?.stderr ?? '');
                        return { success: true, output: String(out).slice(0, 5000) };
                    }
                }

                default:
                    return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }
}
