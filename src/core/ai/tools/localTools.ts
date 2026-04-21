import fs from 'fs';
import path from 'path';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    isStreaming?: boolean;
}

/** Validates that a resolved path is within the project rootDir sandbox */
function assertWithinRoot(resolved: string, rootDir: string, label: string): void {
    const rootResolved = path.resolve(rootDir);
    const normalResolved = path.resolve(resolved);
    if (!normalResolved.startsWith(rootResolved + path.sep) && normalResolved !== rootResolved) {
        throw new Error(`Path sandbox violation: "${label}" resolves outside project root`);
    }
}

/** Reads file content for the AI agent */
export async function readFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... (truncated)' : content;
        return { success: true, output: truncated };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Writes/Creates file content as directed by the AI agent — for NEW files only */
export async function writeFileTool(filePath: string, content: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        assertWithinRoot(resolved, rootDir, filePath);
        if (!content || content.trim().length === 0) {
            return { success: false, output: '', error: `write_file rejected: content is empty for ${filePath}` };
        }
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const isNew = !fs.existsSync(resolved);
        fs.writeFileSync(resolved, content, 'utf8');
        return {
            success: true,
            output: `${isNew ? 'Created' : 'Overwrote'}: ${path.relative(rootDir, resolved)} (${content.split('\n').length} lines)`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/**
 * Applies a unified diff patch to an existing file.
 * This is the correct method for modifying existing files.
 * Avoids full-file hallucination by operating on precise hunks only.
 */
export async function patchFileTool(filePath: string, unifiedDiff: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        assertWithinRoot(resolved, rootDir, filePath);

        if (!unifiedDiff || unifiedDiff.trim().length === 0) {
            return { success: false, output: '', error: `patch_file rejected: diff is empty for ${filePath}` };
        }

        if (!fs.existsSync(resolved)) {
            return { success: false, output: '', error: `File not found for patching: ${filePath}. Use write_file to create new files.` };
        }

        const original = fs.readFileSync(resolved, 'utf8');
        const originalLines = original.split('\n');
        const result: string[] = [...originalLines];
        let offset = 0;
        let totalAdded = 0;
        let totalRemoved = 0;

        const diffLines = unifiedDiff.split('\n');
        let i = 0;

        // Skip file header lines (--- and +++)
        while (i < diffLines.length && (diffLines[i]!.startsWith('---') || diffLines[i]!.startsWith('+++'))) i++;

        const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

        while (i < diffLines.length) {
            const line = diffLines[i]!;
            const hunkMatch = line.match(hunkRegex);
            if (!hunkMatch) { i++; continue; }

            const oldStart = parseInt(hunkMatch[1]!, 10) - 1; // convert to 0-indexed
            i++;

            const removals: string[] = [];
            const additions: string[] = [];

            while (i < diffLines.length && !diffLines[i]!.match(hunkRegex)) {
                const hunkLine = diffLines[i]!;
                if (hunkLine.startsWith('-')) {
                    removals.push(hunkLine.slice(1));
                } else if (hunkLine.startsWith('+')) {
                    additions.push(hunkLine.slice(1));
                }
                // context lines (space prefix) are intentionally skipped — they don't change content
                i++;
            }

            const insertAt = oldStart + offset;
            result.splice(insertAt, removals.length, ...additions);
            offset += additions.length - removals.length;
            totalAdded += additions.length;
            totalRemoved += removals.length;
        }

        fs.writeFileSync(resolved, result.join('\n'), 'utf8');
        const rel = path.relative(rootDir, resolved);
        return {
            success: true,
            output: `Patched: ${rel} (+${totalAdded} -${totalRemoved} lines)`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Deletes a file as directed by the AI agent */
export async function deleteFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        assertWithinRoot(resolved, rootDir, filePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        const stats = fs.statSync(resolved);
        if (stats.isDirectory()) {
            fs.rmSync(resolved, { recursive: true, force: true });
            return { success: true, output: `Deleted directory: ${path.relative(rootDir, resolved)}` };
        } else {
            fs.unlinkSync(resolved);
            return { success: true, output: `Deleted file: ${path.relative(rootDir, resolved)}` };
        }
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Moves or Renames a file/directory */
export async function moveFileTool(oldPath: string, newPath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolvedOld = path.isAbsolute(oldPath) ? oldPath : path.resolve(rootDir, oldPath);
        const resolvedNew = path.isAbsolute(newPath) ? newPath : path.resolve(rootDir, newPath);
        assertWithinRoot(resolvedOld, rootDir, oldPath);
        assertWithinRoot(resolvedNew, rootDir, newPath);
        if (!fs.existsSync(resolvedOld)) {
            return { success: false, output: '', error: `Source not found: ${oldPath}` };
        }
        const dir = path.dirname(resolvedNew);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(resolvedOld, resolvedNew);
        return {
            success: true,
            output: `Moved ${path.relative(rootDir, resolvedOld)} -> ${path.relative(rootDir, resolvedNew)}`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Lists files in a directory for the AI agent */
export async function listFilesTool(dirPath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(rootDir, dirPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return { success: false, output: '', error: `Not a directory: ${dirPath}` };
        }
        const files: string[] = [];
        const walk = (dir: string, depth: number) => {
            if (depth > 3) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (['node_modules', '.git', 'dist', '.cos'].includes(e.name)) continue;
                const full = path.join(dir, e.name);
                files.push(`${e.isDirectory() ? '[DIR]  ' : '[FILE] '}${path.relative(resolved, full)}`);
                if (e.isDirectory()) walk(full, depth + 1);
            }
        };
        walk(resolved, 0);
        return { success: true, output: files.slice(0, 150).join('\n') };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
