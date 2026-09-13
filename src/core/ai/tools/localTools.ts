import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { resolveReadableProjectPath, resolveWithinRoot } from '../../security/PathPolicy.js';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    isStreaming?: boolean;
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function countPatchLines(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}

function canonicalizeSingleFilePatch(filePath: string, unifiedDiff: string, rootDir: string): string {
    const hunkIndex = unifiedDiff.search(/^@@/m);
    if (hunkIndex < 0) {
        throw new Error('patch_file rejected: no unified-diff hunk header (@@ ... @@) was found');
    }

    const body = unifiedDiff.slice(hunkIndex).trimEnd();
    if (/^diff --git /m.test(body) || /^---\s+/m.test(body) || /^\+\+\+\s+/m.test(body)) {
        throw new Error('patch_file rejected: multi-file or nested file headers are not allowed');
    }
    if (/^(rename from|rename to|new file mode|deleted file mode) /m.test(body)) {
        throw new Error('patch_file rejected: rename/create/delete directives are not allowed in patch_file');
    }

    const resolved = resolveWithinRoot(filePath, rootDir, filePath);
    const relative = path.relative(path.resolve(rootDir), resolved).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../')) {
        throw new Error(`patch_file rejected: invalid target path ${filePath}`);
    }
    return `--- a/${relative}\n+++ b/${relative}\n${body}\n`;
}

/** Reads project content that is safe to expose to an AI provider. */
export async function readFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = resolveReadableProjectPath(filePath, rootDir);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        const stat = fs.statSync(resolved);
        if (stat.size > 4 * 1024 * 1024) {
            return { success: false, output: '', error: `read_file rejected: ${filePath} exceeds the 4 MiB text safety limit` };
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const truncated = content.length > 16_000 ? `${content.slice(0, 16_000)}\n... (truncated)` : content;
        return { success: true, output: truncated };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Creates a new file. Existing files must be changed with patch_file. */
export async function writeFileTool(filePath: string, content: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = resolveWithinRoot(filePath, rootDir, filePath);
        if (!content || content.trim().length === 0) {
            return { success: false, output: '', error: `write_file rejected: content is empty for ${filePath}` };
        }
        if (fs.existsSync(resolved)) {
            return {
                success: false,
                output: '',
                error: `write_file rejected: ${filePath} already exists. Read it and use patch_file so the change is context-validated.`,
            };
        }

        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        // Re-check the parent after mkdir so a concurrent symlink swap cannot
        // redirect the final write outside the repository.
        resolveWithinRoot(filePath, rootDir, filePath);
        fs.writeFileSync(resolved, content, { encoding: 'utf8', flag: 'wx' });
        return {
            success: true,
            output: `Created: ${path.relative(rootDir, resolved)} (${content.split('\n').length} lines, sha256=${sha256(content).slice(0, 12)})`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Applies a context-validated single-file unified diff through git apply. */
export async function patchFileTool(filePath: string, unifiedDiff: string, rootDir: string): Promise<ToolResult> {
    let tempPatch: string | null = null;
    try {
        const resolved = resolveWithinRoot(filePath, rootDir, filePath);
        if (!unifiedDiff || unifiedDiff.trim().length === 0) {
            return { success: false, output: '', error: `patch_file rejected: diff is empty for ${filePath}` };
        }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { success: false, output: '', error: `File not found for patching: ${filePath}. Use write_file to create new files.` };
        }

        const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
        if (gitProbe.status !== 0) {
            return { success: false, output: '', error: 'patch_file requires Git for context-validated writes.' };
        }

        const canonicalPatch = canonicalizeSingleFilePatch(filePath, unifiedDiff, rootDir);
        const original = fs.readFileSync(resolved, 'utf8');
        const beforeHash = sha256(original);

        tempPatch = path.join(os.tmpdir(), `codebase-os-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.patch`);
        fs.writeFileSync(tempPatch, canonicalPatch, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

        const commonArgs = ['apply', '--recount', '--whitespace=nowarn'];
        const check = spawnSync('git', [...commonArgs, '--check', tempPatch], {
            cwd: path.resolve(rootDir), encoding: 'utf8', shell: false,
        });
        if (check.status !== 0) {
            const detail = (check.stderr || check.stdout || 'patch context did not match').trim();
            return { success: false, output: '', error: `patch_file rejected before write: ${detail}` };
        }

        if (sha256(fs.readFileSync(resolved, 'utf8')) !== beforeHash) {
            return {
                success: false,
                output: '',
                error: `patch_file rejected: ${filePath} changed after patch validation; re-read and regenerate the patch.`,
            };
        }
        resolveWithinRoot(filePath, rootDir, filePath);

        const apply = spawnSync('git', [...commonArgs, tempPatch], {
            cwd: path.resolve(rootDir), encoding: 'utf8', shell: false,
        });
        if (apply.status !== 0) {
            const detail = (apply.stderr || apply.stdout || 'git apply failed').trim();
            return { success: false, output: '', error: `patch_file failed: ${detail}` };
        }

        const updated = fs.readFileSync(resolved, 'utf8');
        const afterHash = sha256(updated);
        if (afterHash === beforeHash) return { success: false, output: '', error: 'patch_file produced no content change' };

        const { added, removed } = countPatchLines(canonicalPatch);
        return {
            success: true,
            output: `Patched: ${path.relative(rootDir, resolved)} (+${added} -${removed} lines, sha256 ${beforeHash.slice(0, 12)} -> ${afterHash.slice(0, 12)})`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    } finally {
        if (tempPatch) {
            try { fs.unlinkSync(tempPatch); } catch { /* best effort */ }
        }
    }
}

/** Deletes a file or directory inside the project sandbox. */
export async function deleteFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = resolveWithinRoot(filePath, rootDir, filePath);
        if (!fs.existsSync(resolved)) return { success: false, output: '', error: `File not found: ${filePath}` };
        if (path.resolve(resolved) === path.resolve(rootDir)) {
            return { success: false, output: '', error: 'Refusing to delete the project root.' };
        }

        // Revalidate immediately before the destructive call.
        resolveWithinRoot(filePath, rootDir, filePath);
        const stats = fs.lstatSync(resolved);
        if (stats.isDirectory()) {
            fs.rmSync(resolved, { recursive: true, force: false });
            return { success: true, output: `Deleted directory: ${path.relative(rootDir, resolved)}` };
        }
        fs.unlinkSync(resolved);
        return { success: true, output: `Deleted file: ${path.relative(rootDir, resolved)}` };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Moves or renames a path within the project sandbox. */
export async function moveFileTool(oldPath: string, newPath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolvedOld = resolveWithinRoot(oldPath, rootDir, oldPath);
        const resolvedNew = resolveWithinRoot(newPath, rootDir, newPath);
        if (!fs.existsSync(resolvedOld)) return { success: false, output: '', error: `Source not found: ${oldPath}` };
        if (fs.existsSync(resolvedNew)) return { success: false, output: '', error: `Destination already exists: ${newPath}` };

        fs.mkdirSync(path.dirname(resolvedNew), { recursive: true });
        resolveWithinRoot(oldPath, rootDir, oldPath);
        resolveWithinRoot(newPath, rootDir, newPath);
        fs.renameSync(resolvedOld, resolvedNew);
        return { success: true, output: `Moved ${path.relative(rootDir, resolvedOld)} -> ${path.relative(rootDir, resolvedNew)}` };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Lists files without following symlinked directories. */
export async function listFilesTool(dirPath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = resolveWithinRoot(dirPath, rootDir, dirPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return { success: false, output: '', error: `Not a directory: ${dirPath}` };
        }

        const files: string[] = [];
        const walk = (dir: string, depth: number): void => {
            if (depth > 3 || files.length >= 150) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (files.length >= 150) return;
                if (['node_modules', '.git', 'dist', '.cos'].includes(entry.name)) continue;

                const full = path.join(dir, entry.name);
                const display = path.relative(resolved, full);
                files.push(`${entry.isDirectory() ? '[DIR]  ' : entry.isSymbolicLink() ? '[LINK] ' : '[FILE] '}${display}`);
                if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, depth + 1);
            }
        };
        walk(resolved, 0);
        return { success: true, output: files.join('\n') };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
