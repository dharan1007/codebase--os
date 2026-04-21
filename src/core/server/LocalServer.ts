import http from 'http';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import { FailureStore } from '../failure/FailureStore.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';

// Resolve UI root relative to the installed package — works from both src and dist
const UI_ROOT = path.join(__dirname, '../../ui');

export class LocalServer extends EventEmitter {
    private server: http.Server;
    private port = 3000;
    private currentPendingAction: any = null;
    private sseClients: http.ServerResponse[] = [];
    private recentSteps: any[] = [];
    private activeProvider = 'unknown';
    private activeModel = 'unknown';

    constructor(
        private failureStore?: FailureStore,
        public resourceMonitor?: ResourceMonitor
    ) {
        super();
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    start() {
        this.server.listen(this.port, () => {
            logger.info(`[SERVER] Visual UI running at http://localhost:${this.port}`);
            console.log(`\n\x1b[36m[DASHBOARD]\x1b[0m Codebase OS live at \x1b[4mhttp://localhost:${this.port}\x1b[0m\n`);
        });
    }

    stop() {
        // Close all SSE clients
        for (const client of this.sseClients) {
            try { client.end(); } catch { /* already closed */ }
        }
        this.sseClients = [];
        this.server.close();
    }

    /** Called by AgentLoop on every step to broadcast to dashboard */
    emitStep(stepData: { step: number; action: any; result: any }) {
        this.recentSteps.push({ ...stepData, timestamp: Date.now() });
        if (this.recentSteps.length > 50) this.recentSteps.shift();
        this.broadcastSSE('step', stepData);
    }

    setActiveModel(provider: string, model: string) {
        this.activeProvider = provider;
        this.activeModel = model;
        this.broadcastSSE('model', { provider, model });
    }

    setPendingAction(action: any) {
        this.currentPendingAction = action;
        this.emit('action_staged', action);
        this.broadcastSSE('pending_action', action);
    }

    clearPendingAction() {
        this.currentPendingAction = null;
    }

    private broadcastSSE(event: string, data: any) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.sseClients) {
            try { client.write(payload); } catch { /* client disconnected */ }
        }
        // Prune dead clients
        this.sseClients = this.sseClients.filter(c => !c.destroyed);
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        // --- SSE stream for real-time agent events ---
        if (req.method === 'GET' && req.url === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write(':ok\n\n');
            this.sseClients.push(res);

            // Send current backlog immediately
            for (const step of this.recentSteps) {
                res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
            }

            req.on('close', () => {
                this.sseClients = this.sseClients.filter(c => c !== res);
            });
            return;
        }

        // --- Real stats from DB/store ---
        if (req.method === 'GET' && req.url === '/api/stats') {
            const failures = this.failureStore ? this.failureStore.getFrequentFailures(1) : [];
            const budgetReport = this.resourceMonitor ? this.resourceMonitor.getReport() : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                failureCount: failures.length,
                recurringCount: failures.filter((f: any) => f.frequency >= 3).length,
                recentFailures: failures.slice(0, 5),
                budgetReport,
                activeProvider: this.activeProvider,
                activeModel: this.activeModel,
                stepCount: this.recentSteps.length,
            }));
        }

        // --- Last N agent steps ---
        if (req.method === 'GET' && req.url?.startsWith('/api/steps')) {
            const n = 20;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ steps: this.recentSteps.slice(-n) }));
        }

        // --- Approve / reject pending high-risk action ---
        if (req.method === 'POST' && req.url === '/api/approve') {
            this.emit('approve');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'approved' }));
        }

        if (req.method === 'POST' && req.url === '/api/reject') {
            this.emit('reject');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'rejected' }));
        }

        if (req.method === 'GET' && req.url === '/api/pending-action') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(this.currentPendingAction || null));
        }

        // --- Serve static UI files ---
        const urlPath = req.url === '/' ? 'index.html' : (req.url ?? 'index.html');
        let filePath = path.join(UI_ROOT, urlPath);

        const ext = path.extname(filePath);
        const mimeMap: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
        };
        const contentType = mimeMap[ext] ?? 'text/plain';

        fs.readFile(filePath, (err, content) => {
            if (err) {
                // Fallback to index.html for SPA routing
                fs.readFile(path.join(UI_ROOT, 'index.html'), (err2, fallback) => {
                    if (err2) {
                        res.writeHead(404);
                        return res.end('Not Found');
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(fallback, 'utf-8');
                });
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    }
}
