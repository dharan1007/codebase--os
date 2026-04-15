import type { RelationshipGraph } from './RelationshipGraph.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

export class GraphPersistence {
    constructor(private graph: RelationshipGraph, private dataDir: string) { }

    exportSnapshot(label?: string): string {
        const timestamp = Date.now();
        const snapshotDir = path.join(this.dataDir, 'snapshots');
        if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });

        const fileName = `graph-${label ?? timestamp}.json`;
        const filePath = path.join(snapshotDir, fileName);

        const data = this.graph.exportJSON();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

        logger.info('Graph snapshot exported', { path: filePath });
        return filePath;
    }

    listSnapshots(): Array<{ name: string; path: string; size: number; createdAt: Date }> {
        const snapshotDir = path.join(this.dataDir, 'snapshots');
        if (!fs.existsSync(snapshotDir)) return [];

        return fs
            .readdirSync(snapshotDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const full = path.join(snapshotDir, f);
                const stat = fs.statSync(full);
                return { name: f, path: full, size: stat.size, createdAt: stat.birthtime };
            })
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    pruneOldSnapshots(keepCount = 10): void {
        const snapshots = this.listSnapshots();
        if (snapshots.length <= keepCount) return;

        const toDelete = snapshots.slice(keepCount);
        for (const snap of toDelete) {
            fs.unlinkSync(snap.path);
            logger.debug('Pruned old snapshot', { path: snap.path });
        }
    }
}