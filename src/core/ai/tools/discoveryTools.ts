import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TypeScriptAnalyzer } from '../../scanner/TypeScriptAnalyzer.js';
import { logger } from '../../../utils/logger.js';
import type { ToolResult } from './localTools.js';

/**
 * discoveryTools provide the AI agent with 'Deep Vision'.
 * These tools cost ZERO credits because they run entirely on your machine.
 */

export async function searchCodeTool(query: string, rootDir: string): Promise<ToolResult> {
    try {
        // 1. Try Windows-native search with clean PowerShell (Escaped)
        const escapedQuery = query.replace(/'/g, "''");
        const cmd = `PowerShell -NoProfile -Command "Get-ChildItem -Recurse -File | Select-String -Pattern '${escapedQuery}' | Select-Object -First 50 | ForEach-Object { \\"$($_.Filename):$($_.LineNumber): $($_.Line.Trim())\\" }"`;
        
        try {
            const output = execSync(cmd, { cwd: rootDir, encoding: 'utf8', timeout: 8000 });
            if (output.trim()) {
                return { success: true, output: output.trim() };
            }
        } catch (err: any) {
            logger.debug('PowerShell search failed or timed out. Falling back to native search.');
        }

        // 2. Failure-Proof Native Fallback (Node.js)
        return await searchCodeNative(query, rootDir);
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

/**
 * Native Node.js search implementation.
 * Slower than PowerShell but 100% reliable on all systems.
 */
async function searchCodeNative(query: string, rootDir: string): Promise<ToolResult> {
    const matches: string[] = [];
    const maxMatches = 50;
    const regex = new RegExp(query, 'i');

    function walk(dir: string) {
        if (matches.length >= maxMatches) return;
        
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
                walk(fullPath);
            } else {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        matches.push(`${path.relative(rootDir, fullPath)}:${i + 1}: ${lines[i].trim()}`);
                        if (matches.length >= maxMatches) return;
                    }
                }
            }
        }
    }

    try {
        walk(rootDir);
        return {
            success: true,
            output: matches.length > 0 ? matches.join('\n') : 'No matches found.'
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}

export async function findReferencesTool(symbol: string, rootDir: string): Promise<ToolResult> {
    try {
        const analyzer = new TypeScriptAnalyzer(rootDir);
        const references = analyzer.findAllReferences(symbol);
        
        if (references.length === 0) {
            return { success: true, output: `No symbolic references found for '${symbol}'.` };
        }

        const formatted = references
            .slice(0, 50)
            .map(r => `${path.relative(rootDir, r.filePath)}:${r.line}: ${r.context}`)
            .join('\n');

        return {
            success: true,
            output: `Found ${references.length} reference(s):\n${formatted}`
        };
    } catch (err) {
        return { success: false, output: '', error: String(err) };
    }
}
