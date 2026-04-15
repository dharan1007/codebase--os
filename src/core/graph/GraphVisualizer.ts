import type { RelationshipGraph } from './RelationshipGraph.js';
import type { GraphNode, GraphEdge, Layer } from '../../types/index.js';
import fs from 'fs';
import path from 'path';

export interface VisualizationNode {
    id: string;
    label: string;
    kind: string;
    layer: Layer;
    color: string;
    size: number;
    filePath: string;
}

export interface VisualizationEdge {
    id: string;
    source: string;
    target: string;
    label: string;
    color: string;
}

export interface VisualizationData {
    nodes: VisualizationNode[];
    edges: VisualizationEdge[];
    stats: {
        nodeCount: number;
        edgeCount: number;
        layerBreakdown: Record<string, number>;
    };
}

const LAYER_COLORS: Record<Layer, string> = {
    database: '#ef4444',
    backend: '#3b82f6',
    api: '#a855f7',
    frontend: '#10b981',
    config: '#f59e0b',
    infrastructure: '#06b6d4',
};

const KIND_SIZE: Record<string, number> = {
    file: 8,
    class: 12,
    function: 6,
    interface: 10,
    api_endpoint: 14,
    db_table: 14,
    component: 10,
    module: 12,
    type: 6,
    hook: 8,
    variable: 4,
    constant: 4,
    enum: 8,
    db_column: 4,
    db_relation: 6,
    package: 10,
};

export class GraphVisualizer {
    constructor(private graph: RelationshipGraph) { }

    toVisualizationData(filter?: { layer?: Layer; kind?: string; maxNodes?: number }): VisualizationData {
        let nodes = Array.from(this.graph.nodes.values());

        if (filter?.layer) {
            nodes = nodes.filter(n => n.layer === filter.layer);
        }
        if (filter?.kind) {
            nodes = nodes.filter(n => n.kind === filter.kind);
        }
        if (filter?.maxNodes) {
            nodes = this.selectMostConnected(nodes, filter.maxNodes);
        }

        const nodeIds = new Set(nodes.map(n => n.id));
        const edges = Array.from(this.graph.edges.values()).filter(
            e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId)
        );

        const vizNodes: VisualizationNode[] = nodes.map(n => ({
            id: n.id,
            label: n.name,
            kind: n.kind,
            layer: n.layer,
            color: LAYER_COLORS[n.layer] ?? '#94a3b8',
            size: KIND_SIZE[n.kind] ?? 6,
            filePath: n.filePath,
        }));

        const vizEdges: VisualizationEdge[] = edges.map(e => ({
            id: e.id,
            source: e.sourceId,
            target: e.targetId,
            label: e.kind,
            color: this.edgeColor(e.kind),
        }));

        return {
            nodes: vizNodes,
            edges: vizEdges,
            stats: this.graph.getStats(),
        };
    }

    exportSigmaJSON(outputPath: string, filter?: { layer?: Layer; kind?: string; maxNodes?: number }): void {
        const data = this.toVisualizationData(filter);
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
    }

    exportMermaid(filter?: { layer?: Layer; maxNodes?: number }): string {
        const data = this.toVisualizationData({ ...filter, maxNodes: filter?.maxNodes ?? 50 });
        const lines: string[] = ['graph TD'];
        const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);

        for (const node of data.nodes) {
            const label = `${sanitize(node.id)}["${node.label} (${node.kind})"]`;
            lines.push(`  ${label}`);
        }

        for (const edge of data.edges.slice(0, 100)) {
            lines.push(`  ${sanitize(edge.source)} -->|${edge.label}| ${sanitize(edge.target)}`);
        }
        return lines.join('\n');
    }

    exportHTMLVisualization(outputPath: string): void {
        const data = this.toVisualizationData({ maxNodes: 300 });
        const html = this.buildHTMLPage(data);
        fs.writeFileSync(outputPath, html, 'utf8');
    }

    private buildHTMLPage(data: VisualizationData): string {
        const jsonContent = JSON.stringify(data);
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Codebase OS ✨ Relationship Graph</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #030712;
            --card-bg: rgba(17, 24, 39, 0.7);
            --border: rgba(255, 255, 255, 0.08);
            --text: #f3f4f6;
            --text-muted: #9ca3af;
            --primary: #6366f1;
            --secondary: #ec4899;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: var(--bg); 
            color: var(--text); 
            font-family: 'Inter', sans-serif; 
            height: 100vh; 
            overflow: hidden;
            display: flex;
        }

        aside {
            width: 320px;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            z-index: 100;
        }

        .sidebar-header { padding: 24px; border-bottom: 1px solid var(--border); }
        .brand { font-weight: 700; font-size: 1.25rem; color: var(--primary); margin-bottom: 16px; }
        .search-box input {
            width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border);
            border-radius: 8px; padding: 10px 12px; color: var(--text); font-family: inherit;
        }

        .sidebar-content { flex: 1; overflow-y: auto; padding: 16px; }
        .section-title { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin: 20px 0 12px; font-weight: 600; }
        
        .node-list-item {
            padding: 8px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem;
        }
        .node-list-item:hover { background: rgba(255,255,255,0.05); }
        .node-list-item .dot { width: 8px; height: 8px; border-radius: 50%; }

        main { flex: 1; position: relative; }
        canvas { width: 100%; height: 100%; cursor: grab; }

        #tooltip {
            position: fixed; background: rgba(17, 24, 39, 0.95); border: 1px solid var(--border);
            padding: 12px; border-radius: 8px; display: none; z-index: 1000; font-size: 0.8rem;
        }
    </style>
</head>
<body>
    <aside>
        <div class="sidebar-header">
            <div class="brand">Codebase OS</div>
            <div class="search-box"><input type="text" id="node-search" placeholder="Search components..."></div>
        </div>
        <div class="sidebar-content" id="node-results"></div>
    </aside>
    <main>
        <canvas id="graph-canvas"></canvas>
        <div id="tooltip"></div>
    </main>

    <script>
        const DATA = ${jsonContent};
        const COLORS = {
            infrastructure: '#06b6d4', database: '#ef4444', backend: '#3b82f6',
            api: '#a855f7', frontend: '#10b981', config: '#f59e0b'
        };

        const canvas = document.getElementById('graph-canvas');
        const ctx = canvas.getContext('2d');
        const searchInput = document.getElementById('node-search');
        
        let width, height, nodes = [], edges = [], scale = 1, offsetX = 0, offsetY = 0;
        let isDragging = false, lastMouse = {x:0, y:0}, hoveredNode = null;

        function init() {
            width = canvas.width = canvas.clientWidth;
            height = canvas.height = canvas.clientHeight;
            nodes = DATA.nodes.map(n => ({...n, x: (Math.random()-0.5)*width, y: (Math.random()-0.5)*height, vx:0, vy:0}));
            edges = DATA.edges;
            updateSidebar();
            animate();
        }

        function updateSidebar() {
            const list = document.getElementById('node-results');
            const query = searchInput.value.toLowerCase();
            const filtered = nodes.filter(n => n.label.toLowerCase().includes(query)).slice(0, 50);
            list.innerHTML = filtered.map(n => 
                '<div class="node-list-item">' +
                '<div class="dot" style="background:' + (COLORS[n.layer] || '#999') + '"></div>' +
                '<span>' + n.label + '</span>' +
                '</div>'
            ).join('');
        }

        function animate() {
            updatePhysics();
            draw();
            requestAnimationFrame(animate);
        }

        function updatePhysics() {
            nodes.forEach(n => {
                n.vx -= n.x * 0.001;
                n.vy -= n.y * 0.001;
                n.x += n.vx; n.y += n.vy;
                n.vx *= 0.9; n.vy *= 0.9;
            });
            edges.forEach(e => {
                const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target);
                if (!a || !b) return;
                const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx*dx+dy*dy);
                const f = (d - 100) * 0.01;
                a.vx += (dx/d)*f; a.vy += (dy/d)*f; b.vx -= (dx/d)*f; b.vy -= (dy/d)*f;
            });
        }

        function draw() {
            ctx.clearRect(0, 0, width, height);
            ctx.save();
            ctx.translate(width/2 + offsetX, height/2 + offsetY);
            ctx.scale(scale, scale);
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            edges.forEach(e => {
                const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target);
                if (!a || !b) return;
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            });
            nodes.forEach(n => {
                ctx.fillStyle = COLORS[n.layer] || '#999';
                ctx.beginPath(); ctx.arc(n.x, n.y, n.size || 5, 0, Math.PI*2); ctx.fill();
            });
            ctx.restore();
        }

        canvas.addEventListener('mousedown', e => { isDragging = true; lastMouse = {x:e.clientX, y:e.clientY}; });
        window.addEventListener('mousemove', e => {
            if (isDragging) {
                offsetX += e.clientX - lastMouse.x; offsetY += e.clientY - lastMouse.y;
                lastMouse = {x:e.clientX, y:e.clientY};
            }
        });
        window.addEventListener('mouseup', () => isDragging = false);
        canvas.addEventListener('wheel', e => { scale *= (e.deltaY > 0 ? 0.9 : 1.1); e.preventDefault(); }, {passive:false});
        searchInput.addEventListener('input', updateSidebar);
        init();
    </script>
</body>
</html>`;
    }

    private selectMostConnected(nodes: GraphNode[], maxNodes: number): GraphNode[] {
        const scored = nodes.map(n => ({
            node: n,
            score: (this.graph.adjacency.get(n.id)?.size ?? 0) + (this.graph.reverseAdjacency.get(n.id)?.size ?? 0),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxNodes).map(s => s.node);
    }

    private edgeColor(kind: string): string {
        const colors: Record<string, string> = {
            imports: '#3498db', exports: '#2ecc71', calls: '#e74c3c',
            extends: '#f39c12', implements: '#9b59b6', provides: '#1abc9c',
        };
        return colors[kind] ?? '#94a3b8';
    }
}