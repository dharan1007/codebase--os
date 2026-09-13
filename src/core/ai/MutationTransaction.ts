import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { AIProviderKind, ChangeOperation } from '../../types/index.js';
import type { ChangeHistory } from '../../storage/ChangeHistory.js';
import { computeDiff } from '../../utils/diff.js';
import { resolveWithinRoot } from '../security/PathPolicy.js';
import {
    writeFileTool,
    patchFileTool,
    deleteFileTool,
    moveFileTool,
    type ToolResult,
} from './tools/localTools.js';

export type MutationAction =
    | { tool: 'write_file'; args: { path: string; content: string } }
    | { tool: 'patch_file'; args: { path: string; diff: string } }
    | { tool: 'delete_file'; args: { path: string } }
    | { tool: 'move_file'; args: { oldPath: string; newPath: string } };

export interface MutationResult extends ToolResult {
    affectedPaths: string[];
    operation?: ChangeOperation;
}

interface Snapshot {
    operation: ChangeOperation;
    destination: string;
    source?: string;
    relativeDestination: string;
    relativeSource?: string;
    original: string;
}

/**
 * Two-phase mutation journal:
 * 1. capture authoritative pre-state;
 * 2. apply the bounded filesystem tool;
 * 3. persist durable history;
 * 4. compensate the filesystem if persistence fails.
 *
 * A mutation is reported successful only after both filesystem and history are
 * consistent. Compensation is content-guarded so concurrent developer work is
 * never overwritten silently.
 */
export class MutationTransaction {
    constructor(
        private rootDir: string,
        private history: ChangeHistory,
        private sessionId: string,
        private provider: AIProviderKind,
    ) {}

    async execute(step: number, action: MutationAction): Promise<MutationResult> {
        let snapshot: Snapshot;
        try {
            snapshot = this.snapshot(action);
        } catch (err) {
            return { success: false, output: '', error: String(err), affectedPaths: [] };
        }

        const toolResult = await this.apply(action);
        if (!toolResult.success) return { ...toolResult, affectedPaths: [] };

        let updated = '';
        try {
            if (snapshot.operation !== 'delete') updated = fs.readFileSync(snapshot.destination, 'utf8');
            this.record(step, snapshot, updated);
        } catch (persistError) {
            const compensation = this.compensate(snapshot, updated);
            if (!compensation.success) {
                return {
                    success: false,
                    output: '',
                    error:
                        `CRITICAL_TRANSACTION_DIVERGENCE: history persistence failed (${String(persistError)}), ` +
                        `and compensation could not safely restore pre-state (${compensation.error}). Manual recovery required.`,
                    affectedPaths: this.paths(snapshot),
                };
            }
            return {
                success: false,
                output: '',
                error: `History persistence failed; filesystem mutation was compensated: ${String(persistError)}`,
                affectedPaths: [],
            };
        }

        return {
            ...toolResult,
            affectedPaths: this.paths(snapshot),
            operation: snapshot.operation,
        };
    }

    private snapshot(action: MutationAction): Snapshot {
        if (action.tool === 'write_file') {
            const destination = resolveWithinRoot(action.args.path, this.rootDir, action.args.path);
            if (fs.existsSync(destination)) throw new Error(`Create target already exists: ${action.args.path}`);
            return { operation: 'create', destination, relativeDestination: action.args.path, original: '' };
        }

        if (action.tool === 'patch_file') {
            const destination = resolveWithinRoot(action.args.path, this.rootDir, action.args.path);
            if (!fs.existsSync(destination) || !fs.statSync(destination).isFile()) throw new Error(`Patch target not found: ${action.args.path}`);
            return {
                operation: 'modify', destination, relativeDestination: action.args.path,
                original: fs.readFileSync(destination, 'utf8'),
            };
        }

        if (action.tool === 'delete_file') {
            const destination = resolveWithinRoot(action.args.path, this.rootDir, action.args.path);
            if (!fs.existsSync(destination) || !fs.statSync(destination).isFile()) throw new Error('Transactional autonomous delete supports files only.');
            return {
                operation: 'delete', destination, relativeDestination: action.args.path,
                original: fs.readFileSync(destination, 'utf8'),
            };
        }

        const source = resolveWithinRoot(action.args.oldPath, this.rootDir, action.args.oldPath);
        const destination = resolveWithinRoot(action.args.newPath, this.rootDir, action.args.newPath);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Transactional autonomous move supports files only.');
        if (fs.existsSync(destination)) throw new Error(`Move destination already exists: ${action.args.newPath}`);
        return {
            operation: 'move', destination, source,
            relativeDestination: action.args.newPath,
            relativeSource: action.args.oldPath,
            original: fs.readFileSync(source, 'utf8'),
        };
    }

    private async apply(action: MutationAction): Promise<ToolResult> {
        switch (action.tool) {
            case 'write_file': return writeFileTool(action.args.path, action.args.content, this.rootDir);
            case 'patch_file': return patchFileTool(action.args.path, action.args.diff, this.rootDir);
            case 'delete_file': return deleteFileTool(action.args.path, this.rootDir);
            case 'move_file': return moveFileTool(action.args.oldPath, action.args.newPath, this.rootDir);
        }
    }

    private record(step: number, snapshot: Snapshot, updated: string): void {
        const diff = computeDiff(snapshot.original, updated, snapshot.relativeDestination).raw;
        this.history.record({
            id: uuidv4(),
            sessionId: this.sessionId,
            taskId: `agent-step-${step}`,
            filePath: snapshot.destination,
            originalContent: snapshot.original,
            updatedContent: updated,
            diff,
            appliedAt: Date.now(),
            provider: this.provider,
            confidence: 1,
            operation: snapshot.operation,
            sourcePath: snapshot.source,
        });
    }

    private compensate(snapshot: Snapshot, expectedUpdated: string): { success: boolean; error?: string } {
        try {
            if (snapshot.operation === 'create') {
                if (!fs.existsSync(snapshot.destination)) return { success: true };
                const current = fs.readFileSync(snapshot.destination, 'utf8');
                if (current !== expectedUpdated) return { success: false, error: 'created file changed concurrently' };
                resolveWithinRoot(snapshot.destination, this.rootDir, snapshot.relativeDestination);
                fs.unlinkSync(snapshot.destination);
                return { success: true };
            }

            if (snapshot.operation === 'modify') {
                if (!fs.existsSync(snapshot.destination)) return { success: false, error: 'modified file disappeared concurrently' };
                const current = fs.readFileSync(snapshot.destination, 'utf8');
                if (current !== expectedUpdated) return { success: false, error: 'modified file changed concurrently' };
                resolveWithinRoot(snapshot.destination, this.rootDir, snapshot.relativeDestination);
                fs.writeFileSync(snapshot.destination, snapshot.original, 'utf8');
                return { success: true };
            }

            if (snapshot.operation === 'delete') {
                if (fs.existsSync(snapshot.destination)) return { success: false, error: 'deleted path was recreated concurrently' };
                fs.mkdirSync(path.dirname(snapshot.destination), { recursive: true });
                resolveWithinRoot(snapshot.destination, this.rootDir, snapshot.relativeDestination);
                fs.writeFileSync(snapshot.destination, snapshot.original, { encoding: 'utf8', flag: 'wx' });
                return { success: true };
            }

            if (!snapshot.source) return { success: false, error: 'move source snapshot missing' };
            if (fs.existsSync(snapshot.source)) return { success: false, error: 'move source was recreated concurrently' };
            if (!fs.existsSync(snapshot.destination)) return { success: false, error: 'move destination disappeared concurrently' };
            const current = fs.readFileSync(snapshot.destination, 'utf8');
            if (current !== expectedUpdated) return { success: false, error: 'move destination changed concurrently' };
            fs.mkdirSync(path.dirname(snapshot.source), { recursive: true });
            resolveWithinRoot(snapshot.source, this.rootDir, snapshot.relativeSource ?? snapshot.source);
            resolveWithinRoot(snapshot.destination, this.rootDir, snapshot.relativeDestination);
            fs.renameSync(snapshot.destination, snapshot.source);
            return { success: true };
        } catch (err) {
            return { success: false, error: String(err) };
        }
    }

    private paths(snapshot: Snapshot): string[] {
        return snapshot.operation === 'move'
            ? [snapshot.relativeSource!, snapshot.relativeDestination]
            : [snapshot.relativeDestination];
    }
}
