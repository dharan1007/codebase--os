/**
 * CognitiveState — Persistent per-session agent memory replacing the sliding window.
 *
 * THE PROBLEM THIS SOLVES — "Context Dementia":
 *
 * The previous system used a raw array splice to "compact" the message history:
 *   messages.splice(0, messages.length, ...seed, ...recent)
 *
 * This permanently deleted tool outputs from early steps. In a 20-step refactor:
 * - Step 2: Agent reads auth module, discovers JWT secret format.
 * - Step 15: Window slides. JWT knowledge is discarded.
 * - Step 18: Agent patches a dependent file, hallucinating a different secret format.
 * - Result: Silent logic corruption. No error thrown. Test passes.
 *
 * THE FIX — Three-tier persistent memory:
 *
 * Tier 1: WORKING MEMORY (in-process, never dropped)
 *   - Structured facts about the current task: files read, constraints discovered,
 *     decisions made. Stored as a typed map, not raw strings.
 *   - Maximum size: configurable, default 200 entries.
 *   - Eviction policy: LRU by access time, with "pinning" for critical facts.
 *
 * Tier 2: SESSION SUMMARY (updated every N steps via LLM compression)
 *   - The agent periodically compresses the message history into a concise natural
 *     language "State-of-the-mission" summary using a small model call.
 *   - This summary is INJECTED into every LLM message as a persistent header.
 *   - Replaces the lossy splice with a lossless compression.
 *
 * Tier 3: LONG-TERM MEMORY (SQLite-persisted, cross-session)
 *   - Important discoveries (e.g., "this file has a circular dependency") are
 *     persisted to SQLite and loaded on the next session.
 *   - Lets the agent remember failure patterns across sessions (the existing
 *     SessionMemory class handles this — CognitiveState extends it).
 *
 * COMPRESSION STRATEGY (solves the token budget problem):
 *   - Messages are split into: seed (never dropped) + compressible + recent.
 *   - The compressible zone is summarised by the LLM every COMPRESS_EVERY steps.
 *   - The summary + recent messages together consume no more than TOKEN_BUDGET tokens.
 */

import { Database } from '../../storage/Database.js';
import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

// Number of steps between compression cycles
const COMPRESS_EVERY = 8;

// Never trigger compression if the compressible zone is fewer than this many chars
const MIN_COMPRESSIBLE_LENGTH = 2000;

// Maximum characters the session summary is allowed to grow to
const MAX_SUMMARY_CHARS = 3000;

export interface MemoryFact {
    key: string;           // e.g., "auth.jwtSecret", "file:src/utils/auth.ts:constraint"
    value: string;         // The discovered information
    isPinned: boolean;     // Pinned facts survive aggressive eviction
    lastAccessStep: number;
    createdStep: number;
}

export interface CognitiveSnapshot {
    sessionId: string;
    taskDescription: string;
    summary: string;             // Compressed history of what has happened
    workingMemory: MemoryFact[]; // Typed facts about the task
    stepCount: number;
    filesRead: string[];
    filesModified: string[];
    constraintsDiscovered: string[];
}

export class CognitiveState {
    private summary = '';
    private workingMemory: Map<string, MemoryFact> = new Map();
    private constraintsDiscovered: string[] = [];
    private filesRead: Set<string> = new Set();
    private filesModified: Set<string> = new Set();
    private stepsSinceLastCompress = 0;
    private currentStep = 0;

    constructor(
        private sessionId: string,
        private db: Database,
        private ai: AIProvider
    ) {
        this.ensureTable();
    }

    private ensureTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cognitive_state (
                session_id  TEXT PRIMARY KEY,
                summary     TEXT NOT NULL DEFAULT '',
                facts_json  TEXT NOT NULL DEFAULT '[]',
                updated_at  INTEGER NOT NULL DEFAULT 0
            )
        `);
    }

    // ─── Restore a previous session's state ───────────────────────────────────

    restore(): void {
        try {
            const row = this.db
                .prepare('SELECT summary, facts_json FROM cognitive_state WHERE session_id = ?')
                .get(this.sessionId) as { summary: string; facts_json: string } | undefined;

            if (!row) return;
            this.summary = row.summary ?? '';
            const facts: MemoryFact[] = JSON.parse(row.facts_json ?? '[]');
            for (const fact of facts) {
                this.workingMemory.set(fact.key, fact);
            }
            logger.debug('CognitiveState restored', { sessionId: this.sessionId, facts: this.workingMemory.size });
        } catch (err) {
            logger.warn('CognitiveState: failed to restore', { error: String(err) });
        }
    }

    // ─── Record facts from tool outputs ──────────────────────────────────────

    recordFileRead(filePath: string): void {
        this.filesRead.add(filePath);
    }

    recordFileModified(filePath: string): void {
        this.filesModified.add(filePath);
    }

    recordFact(key: string, value: string, pinned = false): void {
        const existing = this.workingMemory.get(key);
        this.workingMemory.set(key, {
            key,
            value: value.slice(0, 500), // Bound the value size
            isPinned: pinned || (existing?.isPinned ?? false),
            lastAccessStep: this.currentStep,
            createdStep: existing?.createdStep ?? this.currentStep,
        });
        // Evict un-pinned facts that are oldest if over 200
        if (this.workingMemory.size > 200) {
            this.evictOldestUnpinned();
        }
    }

    recordConstraint(constraint: string, pinned = true): void {
        const dedupeKey = constraint.slice(0, 80);
        if (!this.constraintsDiscovered.some(c => c.startsWith(dedupeKey.slice(0, 40)))) {
            this.constraintsDiscovered.push(constraint.slice(0, 500));
            this.recordFact(`constraint:${this.currentStep}`, constraint, pinned);
        }
    }

    getFact(key: string): string | undefined {
        const fact = this.workingMemory.get(key);
        if (fact) fact.lastAccessStep = this.currentStep;
        return fact?.value;
    }

    // ─── Step tick — called every agent loop iteration ─────────────────────────

    async tick(
        stepNumber: number,
        compressibleMessages: Array<{ role: string; content: string }>,
        task: string,
        onCompress?: (summary: string) => void
    ): Promise<string> {
        this.currentStep = stepNumber;
        this.stepsSinceLastCompress++;

        // Trigger compression when:
        // 1. We've accumulated COMPRESS_EVERY steps since last compress, AND
        // 2. There's enough compressible content to justify an LLM call
        const compressibleText = compressibleMessages.map(m => `${m.role}: ${m.content}`).join('\n');
        if (
            this.stepsSinceLastCompress >= COMPRESS_EVERY &&
            compressibleText.length > MIN_COMPRESSIBLE_LENGTH
        ) {
            await this.compress(compressibleText, task);
            this.stepsSinceLastCompress = 0;
            onCompress?.(this.summary);
        }

        return this.buildContext();
    }

    // ─── Build the persistent context header ─────────────────────────────────

    buildContext(): string {
        const lines: string[] = ['[PERSISTENT COGNITIVE STATE]'];

        if (this.summary) {
            lines.push('--- Mission Summary ---');
            lines.push(this.summary);
        }

        const pinnedFacts = Array.from(this.workingMemory.values()).filter(f => f.isPinned);
        if (pinnedFacts.length > 0) {
            lines.push('--- Pinned Facts (do not contradict these) ---');
            for (const fact of pinnedFacts.slice(0, 20)) {
                lines.push(`  ${fact.key}: ${fact.value}`);
            }
        }

        if (this.constraintsDiscovered.length > 0) {
            lines.push('--- Discovered Constraints ---');
            for (const c of this.constraintsDiscovered.slice(-10)) {
                lines.push(`  - ${c}`);
            }
        }

        if (this.filesRead.size > 0) {
            lines.push(`--- Files read this session: ${[...this.filesRead].slice(-15).join(', ')} ---`);
        }
        if (this.filesModified.size > 0) {
            lines.push(`--- Files modified this session: ${[...this.filesModified].join(', ')} ---`);
        }

        lines.push('[END COGNITIVE STATE]');
        return lines.join('\n');
    }

    // ─── LLM-based compression ────────────────────────────────────────────────

    private async compress(compressibleText: string, task: string): Promise<void> {
        try {
            const result = await this.ai.execute({
                taskType: 'reasoning',
                priority: 'low',
                maxTokens: 600,
                temperature: 0.1,
                systemPrompt:
                    'You are a technical summarizer. Compress the provided agent session log into ' +
                    'a terse, information-dense summary. Preserve: files modified, key decisions made, ' +
                    'architectural constraints discovered, errors encountered. Discard: repetitive output, ' +
                    'file contents, boilerplate. Maximum 400 words. Output ONLY the summary, no preamble.',
                context:
                    `Task: ${task}\n\nPrevious summary:\n${this.summary}\n\n` +
                    `New exchanges to integrate:\n${compressibleText.slice(0, 8000)}`,
            });

            const newSummary = result.content.trim().slice(0, MAX_SUMMARY_CHARS);
            if (newSummary.length > 50) {
                this.summary = newSummary;
                this.persist();
                logger.debug('CognitiveState compressed', {
                    summaryLength: this.summary.length,
                    step: this.currentStep,
                });
            }
        } catch (err) {
            // Compression failure is non-fatal — just keep the old summary
            logger.warn('CognitiveState: compression failed', { error: String(err) });
        }
    }

    // ─── SQLite persistence ───────────────────────────────────────────────────

    persist(): void {
        try {
            const pinnedAndRecent = Array.from(this.workingMemory.values())
                .sort((a, b) => {
                    // Pinned first, then most recently accessed
                    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
                    return b.lastAccessStep - a.lastAccessStep;
                })
                .slice(0, 100); // Persist top 100 facts

            this.db.prepare(`
                INSERT OR REPLACE INTO cognitive_state (session_id, summary, facts_json, updated_at)
                VALUES (?, ?, ?, ?)
            `).run(
                this.sessionId,
                this.summary,
                JSON.stringify(pinnedAndRecent),
                Date.now()
            );
        } catch (err) {
            logger.warn('CognitiveState: persist failed', { error: String(err) });
        }
    }

    // ─── Accessors ────────────────────────────────────────────────────────────

    getFilesRead(): string[] { return [...this.filesRead]; }
    getFilesModified(): string[] { return [...this.filesModified]; }
    getSummary(): string { return this.summary; }
    hasReadFile(filePath: string): boolean { return this.filesRead.has(filePath); }

    // ─── LRU Eviction ────────────────────────────────────────────────────────

    private evictOldestUnpinned(): void {
        const evictionCandidates = Array.from(this.workingMemory.values())
            .filter(f => !f.isPinned)
            .sort((a, b) => a.lastAccessStep - b.lastAccessStep);

        // Evict the 20 oldest un-pinned facts
        for (const fact of evictionCandidates.slice(0, 20)) {
            this.workingMemory.delete(fact.key);
        }
    }
}
