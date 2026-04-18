import fs from 'fs';
import path from 'path';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
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

/** Writes/Creates file content as directed by the AI agent */
export async function writeFileTool(filePath: string, content: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const isNew = !fs.existsSync(resolved);
        fs.writeFileSync(resolved, content, 'utf8');
        
        return { 
            success: true, 
            output: `${isNew ? 'Created' : 'Updated'}: ${path.relative(rootDir, resolved)}` 
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/** Deletes a file as directed by the AI agent (Safety warning: irreversible) */
export async function deleteFileTool(filePath: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
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
        
        if (!fs.existsSync(resolvedOld)) {
            return { success: false, output: '', error: `Source not found: ${oldPath}` };
        }
        
        const dir = path.dirname(resolvedNew);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.renameSync(resolvedOld, resolvedNew);
        return { 
            success: true, 
            output: `Moved ${path.relative(rootDir, resolvedOld)} to ${path.relative(rootDir, resolvedNew)}` 
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
            if (depth > 2) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (['node_modules', '.git', 'dist', '.cos'].includes(e.name)) continue;
                const full = path.join(dir, e.name);
                files.push(`${e.isDirectory() ? '[DIR] ' : ''}${path.relative(resolved, full)}`);
                if (e.isDirectory()) walk(full, depth + 1);
            }
        };
        walk(resolved, 0);
        return { success: true, output: files.slice(0, 100).join('\n') };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
