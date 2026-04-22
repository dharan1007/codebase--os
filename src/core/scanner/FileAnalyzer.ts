import path from 'path';
import fs from 'fs';
import type { FileAnalysis, Layer, Language } from '../../types/index.js';
import { parseFile } from './ASTParser.js';
import { detectLanguage } from '../../utils/ast.js';
import { normalizePath } from '../../utils/paths.js';
import { ImportResolver } from './ImportResolver.js';

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
    private resolver: ImportResolver;

    constructor(
        private rootDir: string,
        private configuredLayers?: Record<string, string[]>
    ) {
        // ImportResolver is instantiated once per FileAnalyzer instance.
        // It caches tsconfig paths and workspace packages at construction time — O(1) per resolve call.
        this.resolver = new ImportResolver(rootDir);
    }

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

    /**
     * Resolves an import source string to an absolute file path.
     * Delegates to ImportResolver which handles:
     *   - Relative imports (./foo, ../bar)
     *   - tsconfig path aliases (@/components, ~/utils)
     *   - Workspace/monorepo packages
     *   - Barrel index files (src/utils → src/utils/index.ts)
     *   - ESM extension compatibility (.js → .ts)
     */
    resolveImportPath(importSource: string, fromFile: string): string | null {
        return this.resolver.resolve(importSource, fromFile);
    }
}