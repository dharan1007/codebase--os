import path from 'path';
import type { FileAnalysis, Layer } from '../../types/index.js';
import { parseFile } from './ASTParser.js';
import { detectLanguage } from '../../utils/ast.js';
import { normalizePath } from '../../utils/paths.js';
import { ImportResolver } from './ImportResolver.js';
import { analyzeContracts, type ParsedAPICall } from './ContractAnalyzer.js';

export type ExtendedFileAnalysis = FileAnalysis & { apiCalls: ParsedAPICall[] };

const LAYER_PATTERNS: Array<{ pattern: RegExp; layer: Layer }> = [
    { pattern: /\/(migrations?|schema|models?|entities|prisma|drizzle|sequelize|typeorm|knex)\//i, layer: 'database' },
    { pattern: /\.(sql|prisma)$/i, layer: 'database' },
    { pattern: /\/(graphql|resolvers?)\//i, layer: 'api' },
    { pattern: /\.(graphql|gql)$/i, layer: 'api' },
    { pattern: /\/openapi\.|swagger\./i, layer: 'api' },
    { pattern: /\/(controllers?|services?|repositories?|handlers?|middleware|routes?|api)\//i, layer: 'backend' },
    { pattern: /\.(php|rb|py|c|h|cpp|cc|cxx|hpp|cs|java|go|rs)$/i, layer: 'backend' },
    { pattern: /\/(components?|pages?|views?|screens?|layouts?|hooks?|contexts?|widgets?|client|frontend|web)\//i, layer: 'frontend' },
    { pattern: /\.(jsx|tsx|html|htm|css|scss|sass)$/i, layer: 'frontend' },
    { pattern: /\.(dart|swift|kt|kts)$/i, layer: 'frontend' },
    { pattern: /\/(lib\/screens|lib\/widgets|lib\/pages|app\/src\/main\/res)\//i, layer: 'frontend' },
    { pattern: /\/(config|configs?|settings?|environments?)\//i, layer: 'config' },
    { pattern: /\.(env|ya?ml|toml|ini|dockerfile|json)$/i, layer: 'config' },
    { pattern: /\/(docker|k8s|kubernetes|terraform|helm)\//i, layer: 'infrastructure' },
];

export function detectLayer(filePath: string, configuredLayers?: Record<string, string[]>): Layer {
    const normalized = filePath.replace(/\\/g, '/');
    if (configuredLayers) {
        for (const [layer, patterns] of Object.entries(configuredLayers)) {
            for (const configured of patterns) {
                const candidate = configured.replace(/\\/g, '/').replace(/^\.\//, '');
                if (candidate && normalized.includes(candidate)) return layer as Layer;
            }
        }
    }
    for (const { pattern, layer } of LAYER_PATTERNS) {
        if (pattern.test(normalized)) return layer;
    }
    return 'backend';
}

export class FileAnalyzer {
    private resolver: ImportResolver;

    constructor(
        private rootDir: string,
        private configuredLayers?: Record<string, string[]>,
    ) {
        this.resolver = new ImportResolver(rootDir);
    }

    analyze(filePath: string): ExtendedFileAnalysis {
        const normalizedPath = normalizePath(filePath);
        const language = detectLanguage(normalizedPath);
        const layer = detectLayer(normalizedPath, this.configuredLayers);
        const parseResult = parseFile(normalizedPath);
        const contracts = analyzeContracts(normalizedPath);

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
            dbSchemas: contracts.dbSchemas,
            apiCalls: contracts.apiCalls,
            analyzedAt: Date.now(),
            errors: parseResult.errors,
        };
    }

    resolveImportPath(importSource: string, fromFile: string): string | null {
        return this.resolver.resolve(importSource, fromFile);
    }
}
