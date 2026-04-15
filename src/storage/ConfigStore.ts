import { Database } from './Database.js';
import type { ProjectConfig } from '../types/index.js';
import { ProjectConfigSchema } from '../types/index.js';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';

export class ConfigStore {
    constructor(private db: Database, private rootDir: string) { }

    save(config: ProjectConfig): void {
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO project_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('project_config', JSON.stringify(config), now);
    }

    load(): ProjectConfig | null {
        const row = this.db.prepare('SELECT value FROM project_config WHERE key = ?').get('project_config') as
            | { value: string }
            | undefined;
        if (!row) return null;
        try {
            return ProjectConfigSchema.parse(JSON.parse(row.value));
        } catch {
            return null;
        }
    }

    get<T>(key: string): T | null {
        const row = this.db.prepare('SELECT value FROM project_config WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        if (!row) return null;
        try {
            return JSON.parse(row.value) as T;
        } catch {
            return row.value as unknown as T;
        }
    }

    set(key: string, value: unknown): void {
        this.db.prepare(`
      INSERT INTO project_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
    }

    loadFromFile(configFilePath?: string): ProjectConfig | null {
        const candidates = [
            configFilePath,
            path.join(this.rootDir, '.cos', 'config.yaml'),
            path.join(this.rootDir, '.cos', 'config.yml'),
            path.join(this.rootDir, '.cos', 'config.json'),
            path.join(this.rootDir, 'cos.config.yaml'),
            path.join(this.rootDir, 'cos.config.json'),
        ].filter(Boolean) as string[];

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            try {
                const raw = fs.readFileSync(candidate, 'utf8');
                const parsed = candidate.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);
                return ProjectConfigSchema.parse({ ...parsed, rootDir: this.rootDir });
            } catch {
                continue;
            }
        }
        return null;
    }

    saveToFile(config: ProjectConfig): void {
        const cosDir = path.join(this.rootDir, '.cos');
        if (!fs.existsSync(cosDir)) fs.mkdirSync(cosDir, { recursive: true });
        const filePath = path.join(cosDir, 'config.yaml');
        fs.writeFileSync(filePath, yaml.stringify(config), 'utf8');
    }
}