import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../../utils/logger.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { LocalServer } from '../server/LocalServer.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ActionEvaluation {
    riskLevel: RiskLevel;
    scope: number; // estimated lines of code changed
    impact: number; // number of dependencies
    confidence: number;
    reasoning: string;
}

export class DecisionEngine {
    constructor(private graph: RelationshipGraph, private server?: LocalServer) {}

    /**
     * Evaluates an intended action using 3 signals: scope, impact, and confidence.
     */
    evaluate(actionType: string, filePath: string, diffLines: number, confidence: number): ActionEvaluation {
        // Signal 1: Scope
        let scopeRisk = 0;
        const absDiff = Math.abs(diffLines);
        if (absDiff > 200) scopeRisk += 2;
        else if (absDiff > 50) scopeRisk += 1;

        // Signal 2: Dependency Impact
        let impactRisk = 0;
        let impact = 0;
        try {
            const nodes = this.graph.getNodesByFile(filePath);
            const dependents = new Set<string>();
            nodes.forEach(n => {
                this.graph.getDirectDependents(n.id).forEach(d => dependents.add(d.id));
            });
            impact = dependents.size;
            if (impact > 8) impactRisk += 2;
            else if (impact > 2) impactRisk += 1;
        } catch {
            // Node might not exist yet, fallback to 0
        }

        // Signal 3: Confidence Score
        let confidenceRisk = 0;
        if (confidence < 0.5) confidenceRisk += 3;
        else if (confidence < 0.7) confidenceRisk += 2;
        else if (confidence < 0.85) confidenceRisk += 1;

        if (actionType === 'delete_file') impactRisk += 2;
        if (actionType === 'run_shell') {
             // Shell commands can be inherently riskier depending on the command
             // For now, baseline is a bit higher
             confidenceRisk += 1;
        }

        const totalScore = scopeRisk + impactRisk + confidenceRisk;
        
        let riskLevel: RiskLevel = 'low';
        if (totalScore >= 4 || confidenceRisk >= 2 || (actionType === 'run_shell' && totalScore >= 2)) {
            riskLevel = 'high';
        } else if (totalScore >= 2) {
            riskLevel = 'medium';
        }

        let criticalPath = 'None';
        let testCoverage = 'N/A';
        try {
            const nodes = this.graph.getNodesByFile(filePath);
            for (const n of nodes) {
                const visited = new Set<string>();
                const queue: Array<{ id: string; path: string[] }> = [{ id: n.id, path: [] }];
                while (queue.length > 0) {
                    const current = queue.shift()!;
                    const node = this.graph.getNode(current.id);
                    if (!node) continue;
                    const cp = [...current.path, node.name];
                    if (node.layer === 'api' || node.layer === 'frontend') {
                        criticalPath = cp.join(' → '); break;
                    }
                    visited.add(current.id);
                    const deps = this.graph.reverseAdjacency.get(current.id) || new Set();
                    for (const d of deps) {
                        if (!visited.has(d) && cp.length < 5) queue.push({ id: d, path: cp });
                    }
                }
                if (criticalPath !== 'None') break;
            }

            const impactedIds = nodes.map(n => n.id);
            let testedNodes = 0;
            for (const id of impactedIds) {
                const edges = this.graph.getIncomingEdges(id).filter(e => e.kind === 'tests' as any);
                if (edges.length > 0) testedNodes++;
            }
            if (impactedIds.length > 0) {
                const pcnt = Math.round((testedNodes / impactedIds.length) * 100);
                testCoverage = `${pcnt}% (${pcnt > 70 ? 'high' : (pcnt > 30 ? 'medium' : 'low')} confidence)`;
            }
        } catch {}

        const reasoning = `Scope: ~${absDiff} lines | Impact: ${impact} dependents\n    Critical Path: ${criticalPath}\n    Coverage: ${testCoverage}\n    Confidence: ${(confidence * 100).toFixed(0)}%`;

        return { riskLevel, scope: absDiff, impact, confidence, reasoning };
    }

    /**
     * Enforces the action based on strict safety governance.
     * Returns true if the action is allowed to proceed.
     */
    async enforce(action: string, target: string, evaluation: ActionEvaluation): Promise<boolean> {
        const mode = this.getExecutionMode(evaluation);

        if (mode === 'auto') {
            const out = `[SAFETY] Auto-applied ${action} on ${target}`;
            console.log(chalk.green(out));
            logger.info(out);
            return true;
        }

        if (mode === 'stage') {
            const out = `[SAFETY] Staged ${action} on ${target} (Medium Impact)`;
            console.log(chalk.yellow(out));
            console.log(chalk.gray(`  Reasoning: ${evaluation.reasoning}`));
            logger.info(out);
            // Staged actions proceed but are logged prominently
            return true;
        }

        // REQUIRE APPROVAL
        console.log('');
        console.log(chalk.bold.bgRed.white(' ⚠️  HIGH RISK ACTION REQUIRES APPROVAL '));
        console.log(chalk.gray('─'.repeat(50)));
        console.log(`  Action:    ${chalk.bold(action)}`);
        console.log(`  Target:    ${chalk.cyan(target)}`);
        console.log(`  Reasoning: ${chalk.white(evaluation.reasoning)}`);
        console.log(chalk.gray('─'.repeat(50)));
        console.log(chalk.yellow('  Please authorize via Web UI or Terminal...'));

        let approved = false;
        if (this.server) {
            this.server.setPendingAction({ action, target, evaluation });
            approved = await new Promise<boolean>((resolve) => {
                this.server!.once('approve', () => resolve(true));
                this.server!.once('reject', () => resolve(false));
                
                inquirer.prompt([{
                    type: 'confirm',
                    name: 'approved',
                    message: 'Or authorize via terminal?',
                    default: false
                }]).then(ans => resolve(ans.approved));
            });
            this.server.clearPendingAction();
        } else {
            const { approved: cliApproved } = await inquirer.prompt([{
                type: 'confirm',
                name: 'approved',
                message: 'Authorize this execution?',
                default: false
            }]);
            approved = cliApproved;
        }

        if (approved) {
             logger.info('Human approved high risk action', { action, target });
             console.log(chalk.green('  Authorization granted.'));
        } else {
             logger.warn('Human denied high risk action', { action, target });
             console.log(chalk.red('  Authorization denied. Skipping action.'));
        }

        return approved;
    }

    private getExecutionMode(evaluation: ActionEvaluation): 'auto' | 'stage' | 'require_approval' {
        if (evaluation.riskLevel === 'high' || evaluation.confidence < 0.6) {
            return 'require_approval';
        }
        if (evaluation.riskLevel === 'medium') {
            return 'stage';
        }
        return 'auto';
    }
}

