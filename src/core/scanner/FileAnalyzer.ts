import path from 'path';
import fs from 'fs';
import type { FileAnalysis, Layer, Language } from '../../types/index.js';
import { parseFile } from './ASTParser.js';
import { detectLanguage } from '../../utils/ast.js';
import { normalizePath, resolveNormalized } from '../../utils/paths.js';

const LAYER_PATTERNS: Array<{ pattern: RegExp; layer: Layer }> = [
    // Database
    { pattern: /\/(migrations?|schema|models?|entities|prisma|drizzle|sequelize|typeorm|knex)\//i, layer: 'database' },
    { pattern: /\.(sql|prisma)$/i, layer: 'database' },
    // Backend
    { pattern: /\/(controllers?|services?|repositories?|handlers?|middleware|routes?|api)\//i, layer: 'backend' },
    { pattern: /\.(php|rb|py)$/i, layer: 'backend' },
    { pattern: /\.(c|h|cpp|cc|cxx|hpp)$/i, layer: 'backend' },
    // API
    { pattern: /\/(graphql|resolvers?)\//i, layer: 'api' },
    { pattern: /\.(graphql|gql)$/, layer: 'api' },
    { pattern: /\/openapi\.|swagger\./i, layer: 'api' },
    // Frontend / Mobile
    { pattern: /\/(components?|pages?|views?|screens?|layouts?|hooks?|contexts?|widgets?)\//i, layer: 'frontend' },
    { pattern: /\.(jsx|tsx|html|htm|css|scss|sass)$/, layer: 'frontend' },
    { pattern: /\.(dart|swift|kt|kts)$/i, layer: 'frontend' },
    { pattern: /\/(lib\/screens|lib\/widgets|lib\/pages|app\/src\/main\/res)\//i, layer: 'frontend' },
    // Config
    { pattern: /\/(config|configs?|settings?|environments?)\//i, layer: 'config' },
    { pattern: /\.(env|ya?ml|toml|ini|dockerfile|json)$/i, layer: 'config' },
    // Infrastructure
    { pattern: /\/(docker|k8s|kubernetes|terraform|helm)\//i, layer: 'infrastructure' },
    { pattern: /\.(cs)$/i, layer: 'backend' },
    { pattern: /\.(java|go|rs)$/i, layer: 'backend' },
];

export function detectLayer(filePath: string, configuredLayers?: Record<string, string[]>): Layer {
    if (configuredLayers) {
        for (const [layer, patterns] of Object.entries(configuredLayers)) {
            for (const pattern of patterns) {
                if (filePath.includes(pattern)) {
                    return layer as Layer;
                }
            }
        }
    }

    for (const { pattern, layer } of LAYER_PATTERNS) {
        if (pattern.test(filePath)) return layer;
    }

    const segments = filePath.split(path.sep);
    const lastDir = segments[segments.length - 2]?.toLowerCase() ?? '';

    if (['src', 'lib', 'app'].includes(lastDir)) return 'backend';
    return 'backend';
}

export class FileAnalyzer {
    constructor(
        private rootDir: string,
        private configuredLayers?: Record<string, string[]>
    ) { }

    analyze(filePath: string): FileAnalysis {
        const normalizedPath = normalizePath(filePath);
        const language = detectLanguage(normalizedPath);
        const layer = detectLayer(normalizedPath, this.configuredLayers);
        const parseResult = parseFile(normalizedPath);

        return {
            filePath: normalizedPath,
            language,
            layer,
            hash: parseResult.hash,
            imports: parseResult.imports,
            exports: parseResult.exports,
            functions: parseResult.functions,
            classes: parseResult.classes,
            interfaces: parseResult.interfaces,
            types: parseResult.types,
            variables: parseResult.variables,
            apiEndpoints: parseResult.apiEndpoints,
            dbSchemas: [],
            analyzedAt: Date.now(),
            errors: parseResult.errors,
        };
    }

    resolveImportPath(importSource: string, fromFile: string): string | null {
        if (!importSource.startsWith('.')) return null;

        const dir = path.dirname(fromFile);
        let resolved = resolveNormalized(dir, importSource);

        // ESM compatibility: handle .js/.jsx extensions in imports that actually point to .ts/.tsx files
        const jsExtMatch = importSource.match(/\.(js|jsx)$/);
        let tsResolved = resolved;
        if (jsExtMatch) {
            tsResolved = resolved.slice(0, -jsExtMatch[0].length);
        }

        const candidates = [
            resolved,
            `${tsResolved}.ts`,
            `${tsResolved}.tsx`,
            tsResolved,
            `${resolved}.ts`,
            `${resolved}.tsx`,
            path.join(resolved, 'index.ts').replace(/\\/g, '/'),
            path.join(resolved, 'index.tsx').replace(/\\/g, '/'),
            path.join(resolved, 'index.js').replace(/\\/g, '/'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return normalizePath(candidate);
            }
        }

        return null;
    }
}