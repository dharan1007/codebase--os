import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    isStreaming?: boolean;
}

function isWithin(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolves a path inside the project sandbox and defends against both lexical
 * `../` escapes and symlink escapes. For a path that does not exist yet, the
 * nearest existing ancestor is realpath-checked.
 */
function resolveWithinRoot(filePath: string, rootDir: string, label: string): string {
    const rootResolved = path.resolve(rootDir);
    const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(rootResolved, filePath);

    if (!isWithin(candidate, rootResolved)) {
        throw new Error(`Path sandbox violation: "${label}" resolves outside project root`);
    }

    const rootReal = fs.realpathSync(rootResolved);
    if (fs.existsSync(candidate)) {
        const candidateReal = fs.realpathSync(candidate);
        if (!isWithin(candidateReal, rootReal)) {
            throw new Error(`Path sandbox violation: "${label}" escapes project root through a symlink`);
        }
        return candidate;
    }

    let ancestor = path.dirname(candidate);
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }

    if (fs.existsSync(ancestor)) {
        const ancestorReal = fs.realpathSync(ancestor);
        if (!isWithin(ancestorReal, rootReal)) {
            throw new Error(`Path sandbox violation: parent of "${label}" escapes project root through a symlink`);
        }
    }

    return candidate;
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

/**
 * Converts an LLM-produced single-file hunk stream into a canonical patch whose
 * path is controlled by Codebase OS, not by model output.
 */
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

/** Reads file content for the AI agent. */
export async function readFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = resolveWithinRoot(filePath, rootDir, filePath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... (truncated)' : content;
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

        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, content, { encoding: 'utf8', flag: 'wx' });
        return {
            success: true,
            output: `Created: ${path.relative(rootDir, resolved)} (${content.split('\n').length} lines, sha256=${sha256(content).slice(0, 12)})`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/**
 * Applies a single-file unified diff transactionally through `git apply`.
 *
 * `git apply --check` validates every context/removal line against the current
 * file before any write occurs. A stale or hallucinated patch therefore fails
 * closed instead of splicing at an approximate line number.
 */
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
            return {
                success: false,
                output: '',
                error: 'patch_file requires Git so patches can be context-validated with `git apply --check`. Install Git and retry.',
            };
        }

        const canonicalPatch = canonicalizeSingleFilePatch(filePath, unifiedDiff, rootDir);
        const original = fs.readFileSync(resolved, 'utf8');
        const beforeHash = sha256(original);

        tempPatch = path.join(
            os.tmpdir(),
            `codebase-os-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.patch`,
        );
        fs.writeFileSync(tempPatch, canonicalPatch, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

        const commonArgs = ['apply', '--recount', '--whitespace=nowarn'];
        const check = spawnSync('git', [...commonArgs, '--check', tempPatch], {
            cwd: path.resolve(rootDir),
            encoding: 'utf8',
            shell: false,
        });
        if (check.status !== 0) {
            const detail = (check.stderr || check.stdout || 'patch context did not match').trim();
            return {
                success: false,
                output: '',
                error: `patch_file rejected before write: ${detail}`,
            };
        }

        // Protect against a concurrent edit between preflight and apply.
        const currentHash = sha256(fs.readFileSync(resolved, 'utf8'));
        if (currentHash !== beforeHash) {
            return {
                success: false,
                output: '',
                error: `patch_file rejected: ${filePath} changed after patch validation; re-read the file and regenerate the patch.`,
            };
        }

        const apply = spawnSync('git', [...commonArgs, tempPatch], {
            cwd: path.resolve(rootDir),
            encoding: 'utf8',
            shell: false,
        });
        if (apply.status !== 0) {
            const detail = (apply.stderr || apply.stdout || 'git apply failed').trim();
            return { success: false, output: '', error: `patch_file failed without confirmation of a valid write: ${detail}` };
        }

        const updated = fs.readFileSync(resolved, 'utf8');
        const afterHash = sha256(updated);
        if (afterHash === beforeHash) {
            return { success: false, output: '', error: 'patch_file produced no content change' };
        }

        const { added, removed } = countPatchLines(canonicalPatch);
        return {
            success: true,
            output:
                `Patched: ${path.relative(rootDir, resolved)} (+${added} -${removed} lines, ` +
                `sha256 ${beforeHash.slice(0, 12)} -> ${afterHash.slice(0, 12)})`,
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
        if (!fs.existsSync(resolved)) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }
        if (path.resolve(resolved) === path.resolve(rootDir)) {
            return { success: false, output: '', error: 'Refusing to delete the project root.' };
        }

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

/** Moves or renames a file/directory within the project sandbox. */
export async function moveFileTool(oldPath: string, newPath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolvedOld = resolveWithinRoot(oldPath, rootDir, oldPath);
        const resolvedNew = resolveWithinRoot(newPath, rootDir, newPath);
        if (!fs.existsSync(resolvedOld)) {
            return { success: false, output: '', error: `Source not found: ${oldPath}` };
        }
        if (fs.existsSync(resolvedNew)) {
            return { success: false, output: '', error: `Destination already exists: ${newPath}` };
        }

        fs.mkdirSync(path.dirname(resolvedNew), { recursive: true });
        fs.renameSync(resolvedOld, resolvedNew);
        return {
            success: true,
            output: `Moved ${path.relative(rootDir, resolvedOld)} -> ${path.relative(rootDir, resolvedNew)}`,
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Lists files in a directory for the AI agent. */
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

                // Never follow symlinked directories during recursive discovery.
                if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, depth + 1);
            }
        };

        walk(resolved, 0);
        return { success: true, output: files.join('\n') };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
