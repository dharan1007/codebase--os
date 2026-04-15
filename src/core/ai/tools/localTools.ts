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

/** Writes file content as directed by the AI agent */
export async function writeFileTool(filePath: string, content: string, rootDir: string): Promise<ToolResult> {
    try {
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return { success: true, output: `Written: ${path.relative(rootDir, resolved)}` };
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
        return { success: true, output: files.slice(0, 80).join('\n') };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
