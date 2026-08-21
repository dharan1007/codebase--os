/** Semantic risk assessment for autonomous mutations. */
import path from 'path';
import fs from 'fs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { logger } from '../../utils/logger.js';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RiskEvaluation {
    level: RiskLevel;
    score: number;
    reasons: string[];
    blockers: string[];
    autoApprovable: boolean;
}

const HIGH_RISK_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /auth|jwt|token|session|passport|oauth|credentials?/i, reason: 'Authentication/authorization logic' },
    { pattern: /crypto|cipher|encrypt|decrypt|hash|bcrypt|argon|pbkdf/i, reason: 'Cryptographic operations' },
    { pattern: /\.env|config\/.*secret|secrets?\./i, reason: 'Environment/secrets configuration' },
    { pattern: /database|db|migration|schema|model|entity|orm/i, reason: 'Database schema or ORM model' },
    { pattern: /middleware|guard|interceptor|filter|policy/i, reason: 'Security middleware or policy' },
    { pattern: /payment|billing|stripe|braintree|paypal/i, reason: 'Payment processing logic' },
    { pattern: /rbac|permission|role|acl/i, reason: 'Access control logic' },
    { pattern: /deploy|release|workflow|\.github\/workflows|dockerfile|terraform|k8s|helm/i, reason: 'Deployment or infrastructure control plane' },
];

const HIGH_RISK_CONTENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /process\.env(?:\[|\.)/, reason: 'Reads environment variables' },
    { pattern: /\bsecret\b|\bprivateKey\b|\bapiKey\b/i, reason: 'Contains key/secret references' },
    { pattern: /\b(DELETE|DROP|TRUNCATE)\s+TABLE/i, reason: 'Destructive SQL operation' },
    { pattern: /\b(?:exec|execSync|spawn)\s*\(|\beval\s*\(|new Function\s*\(/i, reason: 'Dynamic process/code execution' },
    { pattern: /child_process|node:child_process|\bvm\b/i, reason: 'Dangerous runtime capability' },
    { pattern: /export\s+(default\s+)?interface\s+\w+/i, reason: 'Exported interface' },
    { pattern: /export\s+type\s+\w+/i, reason: 'Exported type' },
];

const TEST_FILE_PATTERNS = /\.(spec|test)\.(ts|js|tsx|jsx)$|__tests__|(?:^|[\\/])tests?(?:[\\/]|$)/i;
const GENERATED_FILE_PATTERNS = /\.generated\.|\.min\.|node_modules|(?:^|[\\/])dist[\\/]|\.d\.ts$/i;

export class DecisionEngine {
    private tsAnalyzer?: TypeScriptAnalyzer;

    constructor(
        private graph: RelationshipGraph,
        private rootDir = process.cwd(),
    ) {
        if (fs.existsSync(path.join(rootDir, 'tsconfig.json'))) {
            try { this.tsAnalyzer = new TypeScriptAnalyzer(rootDir); } catch { /* verifier remains authoritative */ }
        }
    }

    evaluate(
        toolName: string,
        filePath: string,
        changeLines: number,
        confidence: number,
        newContent?: string,
        oldContent?: string,
    ): RiskEvaluation {
        const reasons: string[] = [];
        const blockers: string[] = [];
        let score = 0;

        if (toolName === 'delete_file') {
            return {
                level: 'critical', score: 100,
                reasons: ['File deletion changes repository topology'],
                blockers: ['File deletion requires explicit human confirmation'],
                autoApprovable: false,
            };
        }

        const relPath = this.toRelative(filePath);
        for (const { pattern, reason } of HIGH_RISK_PATH_PATTERNS) {
            if (pattern.test(relPath)) {
                score = Math.max(score, 75);
                reasons.push(`[PATH] ${reason}`);
            }
        }

        // Inspect both old and proposed content before considering test/generated
        // files low risk. Security-sensitive content does not become safe merely
        // because it lives in a fixture or generated-looking path.
        const contentSample = `${oldContent ?? ''}\n${newContent ?? ''}`.slice(0, 12_000);
        for (const { pattern, reason } of HIGH_RISK_CONTENT_PATTERNS) {
            if (pattern.test(contentSample)) {
                score = Math.max(score, 65);
                reasons.push(`[CONTENT] ${reason}`);
            }
        }

        if (oldContent !== undefined && newContent !== undefined && this.tsAnalyzer && /\.[cm]?[jt]sx?$/.test(filePath)) {
            try {
                const breaks = this.tsAnalyzer.detectTypeBreakingChanges(filePath, oldContent, newContent);
                if (breaks.length > 0) {
                    score = Math.max(score, 85);
                    reasons.push(...breaks.slice(0, 5).map(change => `[TYPE BREAK] ${change.description}`));
                }
            } catch (err) {
                logger.debug('DecisionEngine: type-breaking analysis unavailable', { error: String(err), filePath });
            }
        }

        if (score < 60 && TEST_FILE_PATTERNS.test(relPath)) {
            score = Math.max(score, 8);
            reasons.push('Test-only path lowers blast radius');
        }
        if (score < 60 && GENERATED_FILE_PATTERNS.test(relPath)) {
            score = Math.max(score, 15);
            reasons.push('Generated/vendor-like path');
        }

        const fileNodes = this.graph.getNodesByFile(filePath);
        let totalDependents = 0;
        for (const node of fileNodes) totalDependents += this.graph.getIncomingEdges(node.id).length;
        if (totalDependents > 20) {
            score = Math.max(score, 80);
            reasons.push(`High centrality: ${totalDependents} downstream relationships`);
        } else if (totalDependents > 5) {
            score = Math.max(score, 50);
            reasons.push(`${totalDependents} downstream relationships`);
        } else if (totalDependents > 0) {
            score = Math.max(score, 30);
            reasons.push(`${totalDependents} downstream relationships`);
        }

        if (changeLines > 150) {
            score = Math.max(score, 55);
            reasons.push(`Large change: ${changeLines} lines modified`);
        } else if (changeLines > 50) {
            score = Math.max(score, 35);
            reasons.push(`${changeLines} lines modified`);
        } else {
            score = Math.max(score, 10);
        }

        if (confidence < 0.5) {
            score = Math.min(100, score + 20);
            reasons.push(`Low agent confidence (${(confidence * 100).toFixed(0)}%)`);
        }

        let level: RiskLevel;
        if (score >= 80) {
            level = 'critical';
            blockers.push('Critical-risk changes require explicit human approval');
        } else if (score >= 60) level = 'high';
        else if (score >= 30) level = 'medium';
        else level = 'low';

        return {
            level,
            score,
            reasons: [...new Set(reasons)],
            blockers,
            autoApprovable: level === 'low' && blockers.length === 0,
        };
    }

    async enforce(taskDescription: string, filePath: string, evaluation: RiskEvaluation): Promise<boolean> {
        const rel = this.toRelative(filePath);
        logger.info('DecisionEngine evaluation', {
            taskDescription,
            file: rel,
            level: evaluation.level,
            score: evaluation.score,
            reasons: evaluation.reasons,
        });

        if (evaluation.autoApprovable) return true;

        const configured = (process.env['COS_AUTO_APPROVE_RISK'] ?? 'low').toLowerCase();
        const ranks: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
        if (configured in ranks && ranks[evaluation.level] <= ranks[configured as RiskLevel] && evaluation.level !== 'critical') {
            logger.warn('DecisionEngine: non-default auto approval policy accepted risk', { configured, level: evaluation.level, file: rel });
            return true;
        }

        const levelColor = {
            critical: chalk.bgRed.white,
            high: chalk.red,
            medium: chalk.yellow,
            low: chalk.green,
        }[evaluation.level];
        console.log('');
        console.log(chalk.bold(`  Risk Assessment: ${levelColor(evaluation.level.toUpperCase())} (score: ${evaluation.score}/100)`));
        console.log(chalk.gray(`  File: ${rel}`));
        for (const reason of evaluation.reasons) console.log(chalk.gray(`    - ${reason}`));
        for (const blocker of evaluation.blockers) console.log(chalk.red(`  BLOCK: ${blocker}`));

        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            logger.warn('DecisionEngine: interactive approval required but terminal is non-interactive', { file: rel, level: evaluation.level });
            return false;
        }

        try {
            const { confirmed } = await inquirer.prompt([{
                type: 'confirm', name: 'confirmed',
                message: `  Apply ${taskDescription} to ${rel}?`,
                default: false,
            }]);
            return Boolean(confirmed);
        } catch {
            return false;
        }
    }

    static deriveConfidence(hasReadFile: boolean, sessionModifyCount: number, agentTurnNumber: number): number {
        let confidence = 0.9;
        if (!hasReadFile) confidence -= 0.3;
        if (sessionModifyCount > 3) confidence -= 0.2;
        else if (sessionModifyCount > 1) confidence -= 0.1;
        if (agentTurnNumber <= 2) confidence -= 0.1;
        return Math.max(0.1, Math.min(1.0, confidence));
    }

    private toRelative(filePath: string): string {
        const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.rootDir, filePath);
        const relative = path.relative(this.rootDir, resolved).replace(/\\/g, '/');
        return relative && !relative.startsWith('../') ? relative : filePath.replace(/\\/g, '/');
    }
}
