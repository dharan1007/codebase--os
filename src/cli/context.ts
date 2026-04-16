import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../storage/Database.js';
import { GraphStore } from '../storage/GraphStore.js';
import { ChangeHistory } from '../storage/ChangeHistory.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { RelationshipGraph } from '../core/graph/RelationshipGraph.js';
import type { ProjectConfig, AIProvider } from '../types/index.js';
import { AIProviderFactory } from '../core/ai/AIProviderFactory.js';
import { createLogger } from '../utils/logger.js';

export interface AppContext {
    config: ProjectConfig;
    db: Database;
    configStore: ConfigStore;
    graph: RelationshipGraph;
    store: GraphStore;
    aiProvider: AIProvider;
    history: ChangeHistory;
    sessionId: string;
    rootDir: string;
    dataDir: string;
}

let cachedContext: AppContext | null = null;
let cachedContextRootDir: string | null = null;

export async function loadContext(rootDir?: string): Promise<AppContext | null> {
    const cwd = path.resolve(rootDir ?? process.cwd());

    if (cachedContext && cachedContextRootDir === cwd) {
        return cachedContext;
    }

    dotenv.config({ path: path.join(cwd, '.env') });

    const cosDir = path.join(cwd, '.cos');
    if (!fs.existsSync(cosDir)) {
        console.log(chalk.red('\n✗ Codebase OS not initialized in this directory.'));
        console.log(chalk.gray('  Run: cos init\n'));
        return null;
    }

    const db = new Database(cosDir);
    const configStore = new ConfigStore(db, cwd);
    const config = configStore.loadFromFile() ?? configStore.load();

    if (!config) {
        console.log(chalk.red('\n✗ Could not load project configuration.'));
        console.log(chalk.gray('  Run: cos init\n'));
        return null;
    }

    createLogger(cosDir, process.env['COS_LOG_LEVEL'] ?? 'info');

    const graphStore = new GraphStore(db);
    const graph = new RelationshipGraph(graphStore);
    await Promise.resolve(graph.load());

    const history = new ChangeHistory(db);
    const sessionId = uuidv4();
    const aiProvider = AIProviderFactory.create(config);

    cachedContext = {
        config,
        db,
        configStore,
        graph,
        store: graphStore,
        aiProvider,
        history,
        sessionId,
        rootDir: cwd,
        dataDir: cosDir,
    };
    cachedContextRootDir = cwd;

    return cachedContext;
}

export function clearContext(): void {
    cachedContext = null;
    cachedContextRootDir = null;
}