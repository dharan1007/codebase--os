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
    database: '#f43f5e',   // Rose
    backend: '#0ea5e9',    // Cyan
    api: '#10b981',        // Emerald
    frontend: '#3b82f6',   // Blue
    config: '#f59e0b',     // Amber
    infrastructure: '#06b6d4', // Sky
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
        const scriptStart = '<script>';
        const scriptEnd = '</script>';
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Codebase OS ✨ Relationship Graph</title>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        :root {
            --bg: #020617;
            --card-bg: rgba(15, 23, 42, 0.6);
            --border: rgba(255, 255, 255, 0.05);
            --text: #f8fafc;
            --text-muted: #94a3b8;
            --primary: #0ea5e9;
            --accent: #10b981;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: var(--bg); 
            color: var(--text); 
            font-family: 'Space Grotesk', sans-serif; 
            height: 100vh; 
            overflow: hidden;
            display: flex;
        }

        aside {
            width: 400px;
            background: var(--card-bg);
            backdrop-filter: blur(40px);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            z-index: 100;
            box-shadow: 40px 0 80px rgba(0,0,0,0.8);
        }

        .sidebar-header { padding: 40px 32px; border-bottom: 1px solid var(--border); }
        .brand { font-weight: 700; font-size: 1.75rem; letter-spacing: -0.04em; background: linear-gradient(135deg, var(--primary), var(--accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 32px; font-family: 'JetBrains Mono', monospace; }
        
        .search-box { position: relative; }
        .search-box input {
            width: 100%; background: rgba(0,0,0,0.4); border: 1px solid var(--border);
            border-radius: 16px; padding: 14px 20px; color: var(--text); font-family: 'Space Grotesk', inherit;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-size: 0.95rem;
        }
        .search-box input:focus { outline: none; border-color: var(--primary); background: rgba(255,255,255,0.06); }

        .sidebar-content { flex: 1; overflow-y: auto; padding: 24px; }
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 32px; }
        .stat-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border); padding: 16px; border-radius: 12px; }
        .stat-val { font-size: 1.25rem; font-weight: 700; color: var(--primary); }
        .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 4px; }

        .node-list-item {
            padding: 10px 14px; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 12px; font-size: 0.9rem;
            margin-bottom: 4px; border: 1px solid transparent; transition: all 0.2s;
        }
        .node-list-item:hover { background: rgba(255,255,255,0.05); border-color: var(--border); }
        .node-list-item .dot { width: 10px; height: 10px; border-radius: 4px; box-shadow: 0 0 10px currentColor; }

        main { flex: 1; position: relative; }
        #graph { width: 100%; height: 100%; }

        .node circle { cursor: grab; filter: drop-shadow(0 0 8px rgba(255,255,255,0.2)); stroke-width: 2px; }
        .node.active circle { stroke: #fff; stroke-width: 3px; filter: drop-shadow(0 0 15px currentColor); }
        
        .link { stroke-opacity: 0.15; stroke-width: 1.5px; transition: stroke-opacity 0.2s; }
        .link.active { stroke-opacity: 0.8; stroke-width: 2.5px; }

        .label { font-size: 10px; fill: var(--text-muted); pointer-events: none; font-weight: 500; }
        .node.active .label { fill: #fff; font-size: 12px; font-weight: 700; }

        #tooltip {
            position: fixed; background: rgba(17, 24, 39, 0.9); backdrop-filter: blur(10px);
            border: 1px solid var(--border); padding: 16px; border-radius: 12px; 
            display: none; z-index: 1000; font-size: 0.85rem; pointer-events: none;
            box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        }
        .tt-kind { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; background: rgba(255,255,255,0.1); margin-bottom: 8px; }
        .tt-name { font-weight: 700; font-size: 1.1rem; margin-bottom: 4px; }
        .tt-path { color: var(--text-muted); font-family: monospace; font-size: 0.75rem; }
    </style>
</head>
<body>
    <aside>
        <div class="sidebar-header">
            <div class="brand">Codebase OS</div>
            <div class="search-box"><input type="text" id="node-search" placeholder="Search components..."></div>
        </div>
        <div class="sidebar-content">
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-val" id="count-nodes">-</div><div class="stat-label">Nodes</div></div>
                <div class="stat-card"><div class="stat-val" id="count-edges">-</div><div class="stat-label">Links</div></div>
            </div>
            <div id="node-results"></div>
        </div>
    </aside>
    <main>
        <svg id="graph"></svg>
        <div id="tooltip"></div>
    </main>

    ${scriptStart}
        const data = ${jsonContent};
        const width = window.innerWidth - 400;
        const height = window.innerHeight;

        document.getElementById('count-nodes').textContent = data.nodes.length;
        document.getElementById('count-edges').textContent = data.edges.length;

        const svg = d3.select("#graph")
            .attr("viewBox", [0, 0, width, height]);

        const g = svg.append("g");

        const zoom = d3.zoom()
            .scaleExtent([0.1, 8])
            .on("zoom", (event) => g.attr("transform", event.transform));

        svg.call(zoom);

        const simulation = d3.forceSimulation(data.nodes)
            .force("link", d3.forceLink(data.edges).id(d => d.id).distance(120))
            .force("charge", d3.forceManyBody().strength(-400))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("x", d3.forceX(width / 2).strength(0.05))
            .force("y", d3.forceY(height / 2).strength(0.05));

        const link = g.append("g")
            .attr("stroke", "#94a3b8")
            .selectAll("line")
            .data(data.edges)
            .join("line")
            .attr("class", "link");

        const node = g.append("g")
            .selectAll("g")
            .data(data.nodes)
            .join("g")
            .attr("class", "node")
            .call(drag(simulation));

        node.append("circle")
            .attr("r", d => d.size * 1.5)
            .attr("fill", d => d.color)
            .attr("stroke", d => d.color)
            .attr("stroke-opacity", 0.3);

        node.append("text")
            .attr("class", "label")
            .attr("x", d => d.size * 1.5 + 8)
            .attr("y", 3)
            .text(d => d.label);

        node.on("mouseenter", (event, d) => {
            showTooltip(event, d);
            highlightConnections(d);
        });

        node.on("mouseleave", () => {
            hideTooltip();
            resetHighlight();
        });

        simulation.on("tick", () => {
            link
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);

            node
                .attr("transform", d => "translate(" + d.x + "," + d.y + ")");
        });

        function drag(simulation) {
            return d3.drag()
                .on("start", (event) => {
                    if (!event.active) simulation.alphaTarget(0.3).restart();
                    event.subject.fx = event.subject.x;
                    event.subject.fy = event.subject.y;
                })
                .on("drag", (event) => {
                    event.subject.fx = event.x;
                    event.subject.fy = event.y;
                })
                .on("end", (event) => {
                    if (!event.active) simulation.alphaTarget(0);
                    event.subject.fx = null;
                    event.subject.fy = null;
                });
        }

        const tooltip = d3.select("#tooltip");
        function showTooltip(event, d) {
            tooltip.style("display", "block")
                .html('<div class="tt-kind" style="background:'+d.color+'">'+d.kind+'</div>' +
                      '<div class="tt-name">'+d.label+'</div>' +
                      '<div class="tt-path">'+d.filePath+'</div>')
                .style("left", (event.clientX + 20) + "px")
                .style("top", (event.clientY - 20) + "px");
        }

        function hideTooltip() { tooltip.style("display", "none"); }

        function highlightConnections(d) {
            link.attr("class", l => (l.source.id === d.id || l.target.id === d.id) ? "link active" : "link");
            node.attr("class", n => {
                const isNeighbor = data.edges.some(l => 
                    (l.source.id === d.id && l.target.id === n.id) || 
                    (l.target.id === d.id && l.source.id === n.id)
                );
                return (n.id === d.id || isNeighbor) ? "node active" : "node";
            });
        }

        function resetHighlight() {
            link.attr("class", "link");
            node.attr("class", "node");
        }

        // Search functionality
        const searchInput = document.getElementById('node-search');
        const resultsList = document.getElementById('node-results');

        function updateList() {
            const query = searchInput.value.toLowerCase();
            const filtered = data.nodes.filter(n => n.label.toLowerCase().includes(query)).slice(0, 50);
            
            resultsList.innerHTML = filtered.map(n => 
                '<div class="node-list-item" onclick="focusNode(\\'' + n.id + '\\')">' +
                    '<div class="dot" style="background:' + n.color + '"></div>' +
                    '<span>' + n.label + '</span>' +
                '</div>'
            ).join('');
        }

        window.focusNode = (id) => {
            const n = data.nodes.find(d => d.id === id);
            if (!n) return;
            svg.transition().duration(750).call(
                zoom.transform,
                d3.zoomIdentity.translate(width / 2, height / 2).scale(2).translate(-n.x, -n.y)
            );
            highlightConnections(n);
        };

        searchInput.addEventListener('input', updateList);
        updateList();
    ${scriptEnd}
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