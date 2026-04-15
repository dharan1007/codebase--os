import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { loadContext } from '../context.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';

export function mindMapCommand(): Command {
    return new Command('mind-map')
        .alias('mm')
        .description('Show a high-level mind map of the project and planned changes')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, rootDir } = ctx;

            // 1. Group files by module (top-level folders in src)
            const modules = new Map<string, string[]>();
            const activeFiles = new Set<string>();

            // Find "Planned" files from task.md if it exists
            const taskPath = path.join(rootDir, '.cos', 'task.md');
            if (fs.existsSync(taskPath)) {
                const content = fs.readFileSync(taskPath, 'utf8');
                // Simple regex to find file paths in task list
                const matches = content.matchAll(/`([^`]+\.(?:ts|js|py|go|rs))`|\[([^\]]+\.(?:ts|js|py|go|rs))\]/g);
                for (const match of matches) {
                    const f = match[1] || match[2];
                    if (f) activeFiles.add(path.resolve(rootDir, f));
                }
            }

            // Also check recently changed files in this session
            const stmt = ctx.db.prepare('SELECT file_path FROM change_records WHERE session_id = ?');
            const recent = stmt.all(ctx.sessionId) as Array<{ file_path: string }>;
            for (const r of recent) {
                activeFiles.add(r.file_path);
            }

            // Recursively scan src to build module map
            const srcDir = path.join(rootDir, 'src');
            if (fs.existsSync(srcDir)) {
                const entries = fs.readdirSync(srcDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const modFiles: string[] = [];
                        findInterestingFiles(path.join(srcDir, entry.name), modFiles, 0, 2);
                        if (modFiles.length > 0) {
                            modules.set(entry.name, modFiles);
                        }
                    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                        const existing = modules.get('src') ?? [];
                        existing.push(path.join(srcDir, entry.name));
                        modules.set('src', existing);
                    }
                }
            }

            console.log(RichFormatter.formatMindMap(modules, activeFiles));
        });
}

function findInterestingFiles(dir: string, results: string[], depth: number, maxDepth: number) {
    if (depth > maxDepth) return;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findInterestingFiles(full, results, depth + 1, maxDepth);
            } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                // Only pick representative files to keep mind map clean
                if (results.length < 5) results.push(full);
            }
        }
    } catch {}
}
