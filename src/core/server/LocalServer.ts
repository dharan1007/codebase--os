import http from 'http';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import { FailureStore } from '../failure/FailureStore.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';

const UI_ROOT = path.join(process.cwd(), 'src/ui');

export class LocalServer extends EventEmitter {
    private server: http.Server;
    private port = 3000;
    private currentPendingAction: any = null;

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
            console.log(`\n\x1b[36m[SERVER]\x1b[0m Codebase OS Visual UI running at \x1b[4mhttp://localhost:${this.port}\x1b[0m\n`);
        });
    }

    stop() {
        this.server.close();
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (req.method === 'POST' && req.url === '/api/approve') {
            this.emit('approve');
            res.writeHead(200);
            return res.end(JSON.stringify({ status: 'approved' }));
        }

        if (req.method === 'POST' && req.url === '/api/reject') {
            this.emit('reject');
            res.writeHead(200);
            return res.end(JSON.stringify({ status: 'rejected' }));
        }

        if (req.method === 'GET' && req.url === '/api/pending-action') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(this.currentPendingAction || {}));
        }

        if (req.method === 'GET' && req.url === '/api/telemetry') {
            const failures = this.failureStore ? this.failureStore.getFrequentFailures(1) : [];
            const budgetReport = (this as any).resourceMonitor ? (this as any).resourceMonitor.getReport() : [];
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                failureCount: failures.length,
                recurringCount: failures.filter(f => f.frequency >= 3).length,
                recentFailures: failures.slice(0, 5),
                budgetReport
            }));
        }

        if (req.method === 'GET' && req.url === '/api/diff') {
            const currentAction = this.currentPendingAction;
            let diff = 'No changes pending.';
            if (currentAction && currentAction.tool === 'write_file') {
                diff = `[TARGET]: ${currentAction.target}\n\n[REASONING]: ${currentAction.evaluation.reasoning}\n\n[PROPOSED CHANGES]:\n${currentAction.content?.slice(0, 2000)}...`;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ diff }));
        }

        if (req.method === 'GET' && req.url === '/api/reasoning') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ 
                reasoning: this.currentPendingAction?.evaluation.reasoning || 'Agent is idling...' 
            }));
        }

        let filePath = path.join(UI_ROOT, req.url === '/' ? 'index.html' : req.url!);
        
        const extname = path.extname(filePath);
        let contentType = 'text/html';
        switch (extname) {
            case '.js': contentType = 'text/javascript'; break;
            case '.css': contentType = 'text/css'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
        }

        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    }

    setPendingAction(action: any) {
        this.currentPendingAction = action;
        this.emit('action_staged', action);
    }
    
    clearPendingAction() {
        this.currentPendingAction = null;
    }
}

