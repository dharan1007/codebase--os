import crypto from 'crypto';

export interface DiffLine {
    type: 'context' | 'added' | 'removed';
    lineNumber: { old?: number; new?: number };
    content: string;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface UnifiedDiff {
    oldFile: string;
    newFile: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
    raw: string;
}

export function computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function computeDiff(oldContent: string, newContent: string, filePath: string): UnifiedDiff {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const matrix = buildLCSMatrix(oldLines, newLines);
    const rawDiff = backtrack(matrix, oldLines, newLines, oldLines.length, newLines.length);

    const hunks = groupIntoHunks(rawDiff, oldLines, newLines);
    const additions = hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'added').length, 0);
    const deletions = hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'removed').length, 0);
    const raw = renderUnifiedDiff(filePath, hunks);

    return { oldFile: filePath, newFile: filePath, hunks, additions, deletions, raw };
}

function buildLCSMatrix(a: string[], b: string[]): number[][] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i]![j] = dp[i - 1]![j - 1]! + 1;
            } else {
                dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
            }
        }
    }
    return dp;
}

type RawOp = { type: 'context' | 'added' | 'removed'; oldIdx?: number; newIdx?: number; content: string };

function backtrack(
    dp: number[][],
    a: string[],
    b: string[],
    i: number,
    j: number
): RawOp[] {
    if (i === 0 && j === 0) return [];
    if (i === 0) {
        return [
            ...backtrack(dp, a, b, i, j - 1),
            { type: 'added', newIdx: j - 1, content: b[j - 1]! },
        ];
    }
    if (j === 0) {
        return [
            ...backtrack(dp, a, b, i - 1, j),
            { type: 'removed', oldIdx: i - 1, content: a[i - 1]! },
        ];
    }
    if (a[i - 1] === b[j - 1]) {
        return [
            ...backtrack(dp, a, b, i - 1, j - 1),
            { type: 'context', oldIdx: i - 1, newIdx: j - 1, content: a[i - 1]! },
        ];
    }
    if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
        return [
            ...backtrack(dp, a, b, i - 1, j),
            { type: 'removed', oldIdx: i - 1, content: a[i - 1]! },
        ];
    }
    return [
        ...backtrack(dp, a, b, i, j - 1),
        { type: 'added', newIdx: j - 1, content: b[j - 1]! },
    ];
}

function groupIntoHunks(ops: RawOp[], _oldLines: string[], _newLines: string[]): DiffHunk[] {
    const CONTEXT = 3;
    const hunks: DiffHunk[] = [];
    const changed: number[] = [];

    for (let i = 0; i < ops.length; i++) {
        if (ops[i]!.type !== 'context') changed.push(i);
    }

    if (changed.length === 0) return [];

    let cursor = 0;
    while (cursor < changed.length) {
        const start = Math.max(0, changed[cursor]! - CONTEXT);
        let end = changed[cursor]!;

        while (cursor < changed.length && changed[cursor]! <= end + CONTEXT * 2) {
            end = changed[cursor]!;
            cursor++;
        }
        end = Math.min(ops.length - 1, end + CONTEXT);

        const slice = ops.slice(start, end + 1);
        const hunkLines: DiffLine[] = slice.map(op => ({
            type: op.type,
            lineNumber: {
                old: op.oldIdx !== undefined ? op.oldIdx + 1 : undefined,
                new: op.newIdx !== undefined ? op.newIdx + 1 : undefined,
            },
            content: op.content,
        }));

        const firstOld = slice.find(o => o.oldIdx !== undefined)?.oldIdx ?? 0;
        const firstNew = slice.find(o => o.newIdx !== undefined)?.newIdx ?? 0;
        const oldCount = slice.filter(o => o.type !== 'added').length;
        const newCount = slice.filter(o => o.type !== 'removed').length;

        hunks.push({
            oldStart: firstOld + 1,
            oldLines: oldCount,
            newStart: firstNew + 1,
            newLines: newCount,
            lines: hunkLines,
        });
    }

    return hunks;
}

function renderUnifiedDiff(file: string, hunks: DiffHunk[]): string {
    const lines: string[] = [
        `--- a/${file}`,
        `+++ b/${file}`,
    ];

    for (const hunk of hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
            const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
            lines.push(`${prefix}${line.content}`);
        }
    }

    return lines.join('\n');
}

export function applyDiff(original: string, diff: UnifiedDiff): string {
    const lines = original.split('\n');
    const result: string[] = [...lines];
    let offset = 0;

    for (const hunk of diff.hunks) {
        const startIdx = hunk.oldStart - 1 + offset;
        const removals: string[] = [];
        const additions: string[] = [];

        for (const line of hunk.lines) {
            if (line.type === 'removed') removals.push(line.content);
            if (line.type === 'added') additions.push(line.content);
        }

        result.splice(startIdx, removals.length, ...additions);
        offset += additions.length - removals.length;
    }

    return result.join('\n');
}