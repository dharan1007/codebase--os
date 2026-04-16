import BetterSQLite3, { Database as SQLiteDatabase } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import chalk from 'chalk';

const activeInstances = new Set<Database>();

// Graceful Shutdown Registry
const cleanup = () => {
    if (activeInstances.size > 0) {
        logger.info(chalk.yellow('\n🌀 Shutting down gracefully... Cleaning up resources.'));
        for (const db of activeInstances) {
            try {
                db.close();
            } catch { /* ignore */ }
        }
        activeInstances.clear();
    }
};

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

export class Database {
    private db: SQLiteDatabase;

    constructor(dataDir: string) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        const dbPath = path.join(dataDir, 'cos.db');
        this.db = new BetterSQLite3(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -32000');
        this.db.pragma('temp_store = MEMORY');
        this.initialize();
        activeInstances.add(this);
        logger.debug('Database initialized', { path: dbPath });
    }

    private initialize(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        layer TEXT NOT NULL,
        language TEXT NOT NULL,
        signature TEXT,
        doc_comment TEXT,
        location_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_layer ON graph_nodes(layer);

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind);

      CREATE TABLE IF NOT EXISTS file_analyses (
        file_path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        layer TEXT NOT NULL,
        hash TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        analyzed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_content TEXT NOT NULL,
        updated_content TEXT NOT NULL,
        diff TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        rolled_back INTEGER NOT NULL DEFAULT 0,
        rolled_back_at INTEGER,
        provider TEXT NOT NULL,
        confidence REAL NOT NULL,
        impact_report_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_change_records_session ON change_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_change_records_file ON change_records(file_path);

      CREATE TABLE IF NOT EXISTS impact_reports (
        id TEXT PRIMARY KEY,
        trigger_change_json TEXT NOT NULL,
        impacted_nodes_json TEXT NOT NULL,
        affected_layers_json TEXT NOT NULL,
        severity TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        cross_layer_issues_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_reports (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        issues_json TEXT NOT NULL,
        auto_fixed_json TEXT NOT NULL,
        requires_manual_json TEXT NOT NULL,
        summary TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session ON agent_checkpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_status ON agent_checkpoints(status);
    `);
    }

    prepare(sql: string): any {
        return this.db.prepare(sql);
    }

    exec(sql: string): void {
        this.db.exec(sql);
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    close(): void {
        activeInstances.delete(this);
        this.db.close();
    }

    get raw(): SQLiteDatabase {
        return this.db;
    }
}