import http from 'http';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import { FailureStore } from '../failure/FailureStore.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';

const LOOPBACK_HOST = '127.0.0.1';

let UI_ROOT = path.resolve(__dirname, '../../ui');
if (!fs.existsSync(UI_ROOT)) {
    const sourceUi = path.resolve(process.cwd(), 'src', 'ui');
    const distUi = path.resolve(process.cwd(), 'dist', 'ui');
    if (fs.existsSync(sourceUi)) UI_ROOT = sourceUi;
    else if (fs.existsSync(distUi)) UI_ROOT = distUi;
}

export class LocalServer extends EventEmitter {
    private server: http.Server;
    private port: number;
    private currentPendingAction: any = null;
    private sseClients: http.ServerResponse[] = [];
    private recentSteps: any[] = [];
    private activeProvider = 'unknown';
    private activeModel = 'unknown';
    private started = false;

    constructor(
        private failureStore?: FailureStore,
        public resourceMonitor?: ResourceMonitor,
    ) {
        super();
        this.port = this.parsePort(process.env['COS_DASHBOARD_PORT'], 3000);
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    start(): void {
        if (this.started || this.server.listening) return;
        this.started = true;

        const onListening = (): void => {
            const address = this.server.address();
            if (address && typeof address === 'object') this.port = address.port;
            const url = `http://${LOOPBACK_HOST}:${this.port}`;
            logger.info(`[SERVER] Visual UI listening on loopback at ${url}`);
            console.log(`\n\x1b[36m[DASHBOARD]\x1b[0m Codebase OS live at \x1b[4m${url}\x1b[0m\n`);
        };

        this.server.once('listening', onListening);
        this.server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`Dashboard port ${this.port} is busy; selecting an ephemeral loopback port.`);
                this.server.once('listening', onListening);
                this.server.listen(0, LOOPBACK_HOST);
                return;
            }
            this.started = false;
            logger.error('Dashboard server failed to start', { error: err.message });
        });
        this.server.listen(this.port, LOOPBACK_HOST);
    }

    stop(): void {
        for (const client of this.sseClients) {
            try { client.end(); } catch { /* already closed */ }
        }
        this.sseClients = [];
        if (this.server.listening) this.server.close();
        this.started = false;
    }

    emitStep(stepData: { step: number; action: any; result: any }): void {
        this.recentSteps.push({ ...stepData, timestamp: Date.now() });
        if (this.recentSteps.length > 50) this.recentSteps.shift();
        this.broadcastSSE('step', stepData);
    }

    setActiveModel(provider: string, model: string): void {
        this.activeProvider = provider;
        this.activeModel = model;
        this.broadcastSSE('model', { provider, model });
    }

    setPendingAction(action: any): void {
        this.currentPendingAction = action;
        this.emit('action_staged', action);
        this.broadcastSSE('pending_action', action);
    }

    clearPendingAction(): void {
        this.currentPendingAction = null;
    }

    private broadcastSSE(event: string, data: any): void {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.sseClients) {
            try { client.write(payload); } catch { /* client disconnected */ }
        }
        this.sseClients = this.sseClients.filter(client => !client.destroyed);
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.applySecurityHeaders(res);

        const origin = req.headers.origin;
        if (origin && this.isTrustedOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            if (origin && !this.isTrustedOrigin(origin)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write(':ok\n\n');
            this.sseClients.push(res);
            for (const step of this.recentSteps) {
                res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
            }
            req.on('close', () => {
                this.sseClients = this.sseClients.filter(client => client !== res);
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/api/stats') {
            const failures = this.failureStore ? this.failureStore.getFrequentFailures(1) : [];
            const budgetReport = this.resourceMonitor ? this.resourceMonitor.getReport() : [];
            this.writeJson(res, 200, {
                failureCount: failures.length,
                recurringCount: failures.filter((failure: any) => failure.frequency >= 3).length,
                recentFailures: failures.slice(0, 5),
                budgetReport,
                activeProvider: this.activeProvider,
                activeModel: this.activeModel,
                stepCount: this.recentSteps.length,
            });
            return;
        }

        if (req.method === 'GET' && req.url?.startsWith('/api/steps')) {
            this.writeJson(res, 200, { steps: this.recentSteps.slice(-20) });
            return;
        }

        if (req.method === 'POST' && (req.url === '/api/approve' || req.url === '/api/reject')) {
            if (!this.isTrustedMutationRequest(req)) {
                this.writeJson(res, 403, { error: 'Cross-origin dashboard mutation rejected.' });
                return;
            }
            const approved = req.url === '/api/approve';
            this.emit(approved ? 'approve' : 'reject');
            this.writeJson(res, 200, { status: approved ? 'approved' : 'rejected' });
            return;
        }

        if (req.method === 'GET' && req.url === '/api/pending-action') {
            this.writeJson(res, 200, this.currentPendingAction || null);
            return;
        }

        if (req.url === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }

        this.serveStatic(req, res);
    }

    private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
        let rawPath = req.url === '/' ? 'index.html' : (req.url ?? 'index.html').split('?')[0]!;
        try {
            rawPath = decodeURIComponent(rawPath);
        } catch {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }
        rawPath = rawPath.replace(/^\/+/, '');

        const uiRoot = path.resolve(UI_ROOT);
        const candidate = path.resolve(uiRoot, rawPath);
        if (candidate !== uiRoot && !candidate.startsWith(uiRoot + path.sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const ext = path.extname(candidate).toLowerCase();
        const mimeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
        };
        const contentType = mimeMap[ext] ?? 'application/octet-stream';

        fs.readFile(candidate, (err, content) => {
            if (!err) {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
                return;
            }

            if (ext === '' || ext === '.html') {
                const fallbackPath = path.resolve(uiRoot, 'index.html');
                fs.readFile(fallbackPath, (fallbackError, fallback) => {
                    if (fallbackError) {
                        res.writeHead(404);
                        res.end('Not Found');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(fallback);
                });
                return;
            }

            res.writeHead(404);
            res.end('Not Found');
        });
    }

    private applySecurityHeaders(res: http.ServerResponse): void {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
    }

    private isTrustedMutationRequest(req: http.IncomingMessage): boolean {
        const remote = req.socket.remoteAddress;
        if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
        const origin = req.headers.origin;
        return !origin || this.isTrustedOrigin(origin);
    }

    private isTrustedOrigin(origin: string): boolean {
        try {
            const parsed = new URL(origin);
            const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
            const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
            return localHost && port === this.port;
        } catch {
            return false;
        }
    }

    private writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
    }

    private parsePort(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
    }
}
