import fs from 'fs';
import path from 'path';

export class EnvEditor {
    private filePath: string;
    private lines: string[] = [];

    constructor(rootDir: string) {
        this.filePath = path.join(rootDir, '.env');
        this.load();
    }

    private load(): void {
        if (fs.existsSync(this.filePath)) {
            const content = fs.readFileSync(this.filePath, 'utf8');
            this.lines = content.split(/\r?\n/);
        } else {
            this.lines = [];
        }
    }

    get(key: string): string | undefined {
        const line = this.lines.find(l => l.trim().startsWith(`${key}=`));
        if (!line) return undefined;
        return line.split('=')[1]?.trim();
    }

    set(key: string, value: string): void {
        const index = this.lines.findIndex(l => l.trim().startsWith(`${key}=`));
        const newLine = `${key}=${value}`;

        if (index !== -1) {
            this.lines[index] = newLine;
        } else {
            // Add a group header if it's the first Codebase OS variable
            if (this.lines.length === 0 || !this.lines.some(l => l.includes('Codebase OS'))) {
                this.lines.push('', '# Codebase OS — AI Provider Keys');
            }
            this.lines.push(newLine);
        }
    }

    save(): void {
        const content = this.lines.join('\n');
        fs.writeFileSync(this.filePath, content, 'utf8');
    }

    static update(rootDir: string, pairs: Record<string, string>): void {
        const editor = new EnvEditor(rootDir);
        for (const [key, value] of Object.entries(pairs)) {
            editor.set(key, value);
        }
        editor.save();
    }
}
