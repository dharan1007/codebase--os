import BetterSQLite3, { Database as SQLiteDatabase } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const activeInstances = new Set<Database>();
let shutdownStarted = false;

const cleanup = (): void => {
    if (activeInstances.size === 0) return;
    logger.info('Shutting down Codebase OS databases.');
    for (const db of [...activeInstances]) {
        try { db.close(); } catch { /* best effort */ }
    }
    activeInstances.clear();
};

const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    cleanup();
    process.exitCode = exitCode;
    // Installing a signal handler suppresses Node's default termination. Give
    // other cleanup listeners a short window, then guarantee the conventional
    // signal exit code even if a watcher/server handle is still open.
    setTimeout(() => process.exit(exitCode), 500).unref();
};

process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));

export class Database {
    private db: SQLiteDatabase;
    private closed = false;

    constructor(dataDir: string) {
        fs.mkdirSync(dataDir, { recursive: true });
        const dbPath = path.join(dataDir, 'cos.db');
        this.db = new BetterSQLite3(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -32000');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('mmap_size = 536870912');
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
            impact_report_id TEXT,
            operation TEXT NOT NULL DEFAULT 'modify',
            source_path TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_change_records_session ON change_records(session_id);
          CREATE INDEX IF NOT EXISTS idx_change_records_file ON change_records(file_path);
          CREATE INDEX IF NOT EXISTS idx_change_records_applied ON change_records(applied_at);

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

          CREATE TABLE IF NOT EXISTS failure_snapshots (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            filePath TEXT NOT NULL,
            signature TEXT NOT NULL,
            message TEXT NOT NULL,
            stackTrace TEXT,
            contextBefore TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            frequency INTEGER DEFAULT 1
          );

          CREATE INDEX IF NOT EXISTS idx_failure_signature ON failure_snapshots(signature);

          CREATE TABLE IF NOT EXISTS eval_metrics (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL,
            taskProfile TEXT NOT NULL,
            durationMs INTEGER NOT NULL,
            tokensUsed INTEGER NOT NULL,
            successRate REAL NOT NULL,
            regressionDetected INTEGER NOT NULL,
            costEstimate REAL NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            timestamp INTEGER NOT NULL
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

          CREATE TABLE IF NOT EXISTS response_cache (
            queryHash TEXT PRIMARY KEY,
            taskProfile TEXT NOT NULL,
            response TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS embeddings_cache (
            id TEXT PRIMARY KEY,
            filePath TEXT NOT NULL,
            contentHash TEXT NOT NULL,
            content TEXT NOT NULL,
            embeddingBlob BLOB NOT NULL,
            sketchBlob BLOB,
            dim INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL DEFAULT 0
          );

          CREATE INDEX IF NOT EXISTS idx_embed_file_hash ON embeddings_cache(filePath, contentHash);
          CREATE INDEX IF NOT EXISTS idx_embed_filepath ON embeddings_cache(filePath);
        `);

        this.ensureColumn('graph_nodes', 'embedding', 'BLOB');
        this.ensureColumn('change_records', 'operation', "TEXT NOT NULL DEFAULT 'modify'");
        this.ensureColumn('change_records', 'source_path', 'TEXT');
    }

    private ensureColumn(table: string, column: string, definition: string): void {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (columns.some(existing => existing.name === column)) return;
        logger.info('Applying database migration', { table, column });
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }

    prepare(sql: string): any {
        if (this.closed) throw new Error('Database is closed.');
        return this.db.prepare(sql);
    }

    exec(sql: string): void {
        if (this.closed) throw new Error('Database is closed.');
        this.db.exec(sql);
    }

    transaction<T>(fn: () => T): T {
        if (this.closed) throw new Error('Database is closed.');
        return this.db.transaction(fn)();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        activeInstances.delete(this);
        this.db.close();
    }

    get raw(): SQLiteDatabase {
        if (this.closed) throw new Error('Database is closed.');
        return this.db;
    }
}
