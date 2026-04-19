import type { ImpactReport, AITask, ImpactedNode, CrossLayerIssue } from '../../types/index.js';
import type { AIProvider } from '../../types/index.js';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeAIOutput, extractJSONFromAIOutput } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

export class TaskDecomposer {
    constructor(private provider: AIProvider) { }

    async decompose(report: ImpactReport, rootDir: string): Promise<AITask[]> {
        const tasks: AITask[] = [];
        const processedFiles = new Set<string>();

        const requiresUpdateNodes = report.impactedNodes.filter(n => n.requiresUpdate);

        for (const impacted of requiresUpdateNodes) {
            const filePath = impacted.node.filePath;
            if (processedFiles.has(filePath)) continue;
            processedFiles.add(filePath);

            const fileContent = this.safeReadFile(filePath);
            if (!fileContent) continue;

            const task = await this.createTaskForNode(
                impacted,
                fileContent,
                filePath,
                report,
                rootDir
            );
            if (task) tasks.push(task);
        }

        for (const issue of report.crossLayerIssues.filter(i => i.autoFixable !== false)) {
            const crossLayerTasks = await this.createTasksForCrossLayerIssue(issue, report, rootDir);
            tasks.push(...crossLayerTasks);
        }

        tasks.sort((a, b) => b.priority - a.priority);
        logger.info('Task decomposition complete', { taskCount: tasks.length });
        return tasks;
    }

    private async createTaskForNode(
        impacted: ImpactedNode,
        fileContent: string,
        filePath: string,
        report: ImpactReport,
        rootDir: string
    ): Promise<AITask | null> {
        const systemPrompt = `You are an expert software engineer helping maintain a complex codebase.
Your task is to analyze code changes and determine exactly what needs to be updated in a specific file.
Be precise, conservative, and only suggest changes that are strictly necessary.
You must respond with a valid JSON object.`;

        const triggerContent = this.safeReadFile(report.triggerChange.filePath) ?? '[deleted]';

        const userPrompt = `A change was made to: ${report.triggerChange.filePath}
Change type: ${report.triggerChange.changeType}
Severity: ${report.severity}
Scopes affected: ${report.scope.join(', ')}

The changed file now contains:
\`\`\`
${triggerContent.slice(0, 3000)}
\`\`\`

The following file was determined to be impacted:
File: ${filePath}
Reason: ${impacted.reason}
Suggested action: ${impacted.suggestedAction ?? 'Review and update as needed'}

Current content of impacted file:
\`\`\`
${fileContent.slice(0, 3000)}
\`\`\`

Analyze whether this file actually needs changes. If yes, describe exactly what changes are needed.
Respond with JSON:
{
  "needsUpdate": boolean,
  "description": "what needs to change and why",
  "constraints": ["constraint1", "constraint2"],
  "expectedOutput": "description of what the updated file should look like",
  "priority": 1-10
}`;

        try {
            const result = await this.provider.execute({
                taskType: 'analysis',
                priority: 'medium',
                context: userPrompt,
                systemPrompt,
                maxTokens: 1000,
            });

            const parsed = extractJSONFromAIOutput(result.content) as {
                needsUpdate: boolean;
                description: string;
                constraints: string[];
                expectedOutput: string;
                priority: number;
            };

            if (!parsed.needsUpdate) return null;

            return {
                id: uuidv4(),
                kind: 'update',
                description: parsed.description,
                targetFile: filePath,
                targetNodeId: impacted.node.id,
                context: `Triggered by change to ${report.triggerChange.filePath}. ${impacted.reason}`,
                constraints: parsed.constraints ?? [],
                expectedOutput: parsed.expectedOutput,
                priority: parsed.priority ?? 5,
            };
        } catch (err) {
            logger.debug('Task creation failed for node', { file: filePath, error: String(err) });
            return {
                id: uuidv4(),
                kind: 'update',
                description: impacted.suggestedAction ?? `Update ${filePath} due to changes in ${report.triggerChange.filePath}`,
                targetFile: filePath,
                targetNodeId: impacted.node.id,
                context: impacted.reason,
                constraints: ['Maintain existing API surface where possible', 'Do not change unrelated code'],
                expectedOutput: 'Updated file compatible with the changed dependency',
                priority: impacted.severity === 'breaking' ? 10 : impacted.severity === 'major' ? 7 : 4,
            };
        }
    }

    private async createTasksForCrossLayerIssue(
        issue: CrossLayerIssue,
        report: ImpactReport,
        rootDir: string
    ): Promise<AITask[]> {
        const tasks: AITask[] = [];
        const processedFiles = new Set<string>();

        for (const nodeId of issue.affectedNodeIds) {
            const node = report.impactedNodes.find(n => n.node.id === nodeId)?.node;
            if (!node || processedFiles.has(node.filePath)) continue;
            processedFiles.add(node.filePath);

            tasks.push({
                id: uuidv4(),
                kind: 'sync',
                description: issue.description,
                targetFile: node.filePath,
                targetNodeId: nodeId,
                context: `Cross-layer issue: ${issue.sourceLayer} → ${issue.targetLayer}`,
                constraints: [
                    'Only update code relevant to this cross-layer synchronization',
                    issue.resolution ?? 'Follow best practices for cross-layer integration',
                ],
                expectedOutput: `File updated to resolve cross-layer sync issue: ${issue.description}`,
                priority: issue.severity === 'breaking' ? 10 : issue.severity === 'major' ? 8 : 5,
            });
        }

        return tasks;
    }

    private safeReadFile(filePath: string): string | null {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return null;
        }
    }
}