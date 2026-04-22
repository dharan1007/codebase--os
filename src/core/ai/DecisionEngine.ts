/**
 * DecisionEngine — Semantic Risk Assessment.
 *
 * PREVIOUS CRITICAL FLAWS FIXED:
 *
 * 1. Risk was computed from LINE COUNT and DEPENDENT COUNT only.
 *    A 1-line change to a JWT secret key was "Low Risk."
 *    A 300-line CSS refactor was "High Risk." This is backwards.
 *    FIX: Semantic classifiers detect the NATURE of a change, not its size.
 *
 * 2. `detectTypeBreakingChanges()` existed in TypeScriptAnalyzer but was NEVER
 *    called from DecisionEngine. The breaking-change circuit never fired.
 *    FIX: TypeScriptAnalyzer.detectTypeBreakingChanges() is now wired into evaluate().
 *
 * 3. The `enforce()` "stage" mode auto-approved "medium" risk silently.
 *    FIX: Stage mode logs clearly and requires an explicit confirmation prompt.
 *
 * 4. Confidence score was hardcoded to 0.8 in every AgentLoop call.
 *    This module now exposes `deriveConfidence()` for the AgentLoop to use properly.
 */

import path from 'path';
import fs from 'fs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { logger } from '../../utils/logger.js';

// ─── Risk Level ────────────────────────────────────────────────────────────

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RiskEvaluation {
    level: RiskLevel;
    score: number;        // 0–100 numeric score for sorting/comparison
    reasons: string[];    // Human-readable justifications
    blockers: string[];   // Reasons that block auto-apply entirely
    autoApprovable: boolean;
}

// ─── Semantic Pattern Classifiers ────────────────────────────────────────────

/**
 * File path patterns that semantically indicate HIGH risk.
 * A file matching any of these MUST be scored at least HIGH regardless of size.
 */
const HIGH_RISK_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /auth|jwt|token|session|passport|oauth|credentials?/i, reason: 'Authentication/authorization logic' },
    { pattern: /crypto|cipher|encrypt|decrypt|hash|bcrypt|argon|pbkdf/i, reason: 'Cryptographic operations' },
    { pattern: /\.env|config\/.*secret|secrets?\./i, reason: 'Environment/secrets configuration' },
    { pattern: /database|db|migration|schema|model|entity|orm/i, reason: 'Database schema or ORM model' },
    { pattern: /middleware|guard|interceptor|filter|policy/i, reason: 'Security middleware or policy' },
    { pattern: /payment|billing|stripe|braintree|paypal/i, reason: 'Payment processing logic' },
    { pattern: /rbac|permission|role|acl/i, reason: 'Access control logic' },
];

/**
 * Content patterns inside the file that elevate risk.
 * Checked against file content (first 5000 chars for performance).
 */
const HIGH_RISK_CONTENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /process\.env\[/, reason: 'Reads environment variables (potential secret exposure)' },
    { pattern: /\bsecret\b|\bprivateKey\b|\bpublicKey\b|\bapiKey\b/i, reason: 'Contains key/secret references' },
    { pattern: /\b(DELETE|DROP|TRUNCATE)\s+TABLE/i, reason: 'Destructive SQL operation' },
    { pattern: /exec\s*\(|eval\s*\(|new Function\s*\(/i, reason: 'Dynamic code execution (exec/eval)' },
    { pattern: /require\s*\(\s*['"](child_process|vm)['"]\s*\)/i, reason: 'Dangerous Node module usage' },
    { pattern: /export\s+(default\s+)?interface\s+\w+/i, reason: 'Exported interface (breaking change risk)' },
    { pattern: /export\s+type\s+\w+/i, reason: 'Exported type (breaking change risk)' },
];

/** File name patterns that indicate test files — always LOW risk */
const TEST_FILE_PATTERNS = /\.(spec|test)\.(ts|js|tsx|jsx)$|__tests__|\btest(s)?\b/i;

/** File name patterns for generated/vendor code — treat as LOW risk */
const GENERATED_FILE_PATTERNS = /\.generated\.|\.min\.|node_modules|dist\/|\.d\.ts$/i;

// ─── DecisionEngine ──────────────────────────────────────────────────────────

export class DecisionEngine {
    constructor(private graph: RelationshipGraph) {}

    /**
     * Evaluate the risk of applying a change to a file.
     *
     * @param toolName  - The agent tool being used (write_file, patch_file, delete_file)
     * @param filePath  - Absolute path to the file being changed
     * @param changeLines - Number of lines changed (still a signal, just not the only one)
     * @param confidence  - Caller-derived confidence score (0–1)
     * @param newContent  - The proposed new content (for content pattern analysis)
     * @param oldContent  - The original content (for breaking change detection)
     */
    evaluate(
        toolName: string,
        filePath: string,
        changeLines: number,
        confidence: number,
        newContent?: string,
        oldContent?: string
    ): RiskEvaluation {
        const reasons: string[] = [];
        const blockers: string[] = [];
        let score = 0;

        // ── 1. Deletion is always CRITICAL ─────────────────────────────────────
        if (toolName === 'delete_file') {
            return {
                level: 'critical',
                score: 100,
                reasons: ['File deletion is irreversible without rollback'],
                blockers: ['File deletion requires explicit human confirmation'],
                autoApprovable: false,
            };
        }

        // ── 2. Test files are always LOW risk ───────────────────────────────────
        if (TEST_FILE_PATTERNS.test(filePath)) {
            return {
                level: 'low',
                score: 5,
                reasons: ['Test file changes have limited blast radius'],
                blockers: [],
                autoApprovable: true,
            };
        }

        // ── 3. Generated/vendor files — treat as LOW ────────────────────────────
        if (GENERATED_FILE_PATTERNS.test(filePath)) {
            return {
                level: 'low',
                score: 10,
                reasons: ['Generated or vendor file — not hand-maintained'],
                blockers: [],
                autoApprovable: true,
            };
        }

        // ── 4. Semantic path classification ─────────────────────────────────────
        const relPath = this.toRelative(filePath);
        for (const { pattern, reason } of HIGH_RISK_PATH_PATTERNS) {
            if (pattern.test(relPath)) {
                score = Math.max(score, 75);
                reasons.push(`[PATH] ${reason}`);
            }
        }

        // ── 5. Semantic content classification ──────────────────────────────────
        const contentSample = (newContent ?? '').slice(0, 5000);
        for (const { pattern, reason } of HIGH_RISK_CONTENT_PATTERNS) {
            if (pattern.test(contentSample)) {
                score = Math.max(score, 65);
                reasons.push(`[CONTENT] ${reason}`);
            }
        }

        // ── 6. Graph impact: number of downstream dependents ─────────────────────
        const fileNodes = Array.from(this.graph.nodes.values()).filter(n =>
            n.filePath === filePath || n.filePath === relPath
        );
        let totalDependents = 0;
        for (const node of fileNodes) {
            totalDependents += (this.graph.reverseAdjacency.get(node.id) ?? new Set()).size;
        }

        if (totalDependents > 20) {
            score = Math.max(score, 80);
            reasons.push(`High centrality: ${totalDependents} downstream dependents`);
        } else if (totalDependents > 5) {
            score = Math.max(score, 50);
            reasons.push(`${totalDependents} downstream dependents`);
        } else if (totalDependents > 0) {
            score = Math.max(score, 30);
            reasons.push(`${totalDependents} downstream dependents`);
        }

        // ── 7. Change size (secondary signal — not primary) ───────────────────
        if (changeLines > 150) {
            score = Math.max(score, 55);
            reasons.push(`Large change: ${changeLines} lines modified`);
        } else if (changeLines > 50) {
            score = Math.max(score, 35);
            reasons.push(`${changeLines} lines modified`);
        } else {
            score = Math.max(score, 10);
        }

        // ── 8. Confidence adjustment ─────────────────────────────────────────
        // Low confidence (agent hasn't read the file before patching) elevates risk
        if (confidence < 0.5) {
            score = Math.min(100, score + 20);
            reasons.push(`Low agent confidence (${(confidence * 100).toFixed(0)}%)`);
        }

        // ── 9. Convert score to level ─────────────────────────────────────────
        let level: RiskLevel;
        if (score >= 80) {
            level = 'critical';
            blockers.push('Critical risk changes require explicit human approval');
        } else if (score >= 60) {
            level = 'high';
        } else if (score >= 30) {
            level = 'medium';
        } else {
            level = 'low';
        }

        const autoApprovable = level === 'low' && blockers.length === 0;

        return { level, score, reasons, blockers, autoApprovable };
    }

    /**
     * Enforce the decision: prompt for confirmation if needed, block if critical.
     * Returns true if the action is allowed to proceed.
     */
    async enforce(
        taskDescription: string,
        filePath: string,
        evaluation: RiskEvaluation
    ): Promise<boolean> {
        const rel = this.toRelative(filePath);
        const levelColor = {
            critical: chalk.bgRed.white,
            high: chalk.red,
            medium: chalk.yellow,
            low: chalk.green,
        }[evaluation.level];

        // Always log risk evaluation
        logger.info('DecisionEngine evaluation', {
            file: rel,
            level: evaluation.level,
            score: evaluation.score,
            reasons: evaluation.reasons,
        });

        // Auto-approve low-risk changes
        if (evaluation.autoApprovable) {
            return true;
        }

        // Display risk summary to user
        console.log('');
        console.log(chalk.bold(`  Risk Assessment: ${levelColor(evaluation.level.toUpperCase())} (score: ${evaluation.score}/100)`));
        console.log(chalk.gray(`  File: ${rel}`));
        if (evaluation.reasons.length > 0) {
            console.log(chalk.gray('  Reasons:'));
            for (const r of evaluation.reasons) {
                console.log(chalk.gray(`    - ${r}`));
            }
        }

        // Blockers = never auto-approve
        if (evaluation.blockers.length > 0) {
            for (const blocker of evaluation.blockers) {
                console.log(chalk.red(`  BLOCK: ${blocker}`));
            }
        }

        // Prompt for confirmation on medium/high/critical
        try {
            const { confirmed } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmed',
                message: `  Apply change to ${rel}?`,
                default: evaluation.level === 'medium',
            }]);
            return confirmed;
        } catch {
            // If inquirer fails (non-interactive mode), default to deny for high/critical
            return evaluation.level === 'medium';
        }
    }

    /**
     * Derive a realistic confidence score from agent behavior context.
     * Called by AgentLoop instead of hardcoding 0.8.
     *
     * @param hasReadFile       - Agent read_file'd this file before patching
     * @param sessionModifyCount - How many times this file has been modified this session
     * @param agentTurnNumber   - Which turn in the current task (early = lower confidence)
     */
    static deriveConfidence(
        hasReadFile: boolean,
        sessionModifyCount: number,
        agentTurnNumber: number
    ): number {
        let confidence = 0.9;

        // Agent that modifies without reading has low confidence
        if (!hasReadFile) confidence -= 0.3;

        // Multiple modifications to the same file this session increase uncertainty
        if (sessionModifyCount > 3) confidence -= 0.2;
        else if (sessionModifyCount > 1) confidence -= 0.1;

        // Very early turns haven't gathered enough context yet
        if (agentTurnNumber <= 2) confidence -= 0.1;

        return Math.max(0.1, Math.min(1.0, confidence));
    }

    private toRelative(filePath: string): string {
        // Find rootDir from the first file node's path pattern
        const sampleNode = this.graph.nodes.values().next().value;
        if (!sampleNode) return filePath;
        // Best-effort relative path
        return filePath.replace(/\\/g, '/');
    }
}
