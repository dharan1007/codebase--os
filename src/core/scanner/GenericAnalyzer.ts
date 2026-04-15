import fs from 'fs';
import type { ParsedFunction, ParsedClass, ParsedImport, ParsedExport, Language, SourceLocation } from '../../types/index.js';
import { contentHash } from '../../utils/ast.js';

export interface GenericParseResult {
    language: Language;
    hash: string;
    imports: ParsedImport[];
    exports: ParsedExport[];
    functions: ParsedFunction[];
    classes: ParsedClass[];
    errors: string[];
}

// Heuristic patterns for each language
const LANGUAGE_PATTERNS: Record<string, {
    importPatterns: RegExp[];
    functionPatterns: RegExp[];
    classPatterns: RegExp[];
    exportPatterns: RegExp[];
}> = {
    python: {
        importPatterns: [/^(?:import|from)\s+([\w.]+)/],
        functionPatterns: [/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/m],
        classPatterns: [/^class\s+(\w+)(?:\(([^)]*)\))?:/m],
        exportPatterns: [],
    },
    kotlin: {
        importPatterns: [/^import\s+([\w.]+)/],
        functionPatterns: [/(?:fun|suspend fun)\s+(\w+)\s*\(([^)]*)\)/m],
        classPatterns: [/(?:class|object|interface|data class|sealed class)\s+(\w+)/m],
        exportPatterns: [],
    },
    java: {
        importPatterns: [/^import\s+([\w.]+);/],
        functionPatterns: [/(?:public|private|protected|static)[\w\s]+\s+(\w+)\s*\(([^)]*)\)\s*(?:throws[\w\s,]+)?\s*\{/m],
        classPatterns: [/(?:public|private|protected)?\s*(?:abstract|final)?\s*(?:class|interface|enum)\s+(\w+)/m],
        exportPatterns: [],
    },
    go: {
        importPatterns: [/^import\s+"([\w./]+)"/],
        functionPatterns: [/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/m],
        classPatterns: [/^type\s+(\w+)\s+struct/m],
        exportPatterns: [],
    },
    rust: {
        importPatterns: [/^use\s+([\w::{},\s]+);/],
        functionPatterns: [/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/m],
        classPatterns: [/(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/m],
        exportPatterns: [/^pub\s+(?:fn|struct|enum|trait)\s+(\w+)/m],
    },
    csharp: {
        importPatterns: [/^using\s+([\w.]+);/],
        functionPatterns: [/(?:public|private|protected|internal|static|async|virtual|override)[\w\s]+\s+(\w+)\s*\(([^)]*)\)\s*(?:=>|\{)/m],
        classPatterns: [/(?:public|private|internal|abstract|sealed)?\s*(?:partial\s+)?(?:class|interface|struct|record|enum)\s+(\w+)/m],
        exportPatterns: [],
    },
    swift: {
        importPatterns: [/^import\s+(\w+)/],
        functionPatterns: [/(?:func|async func)\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/m],
        classPatterns: [/(?:class|struct|protocol|actor|enum)\s+(\w+)/m],
        exportPatterns: [/public\s+(?:class|struct|func|protocol|enum)\s+(\w+)/m],
    },
    dart: {
        importPatterns: [/^import\s+'([^']+)'/],
        functionPatterns: [/(?:Future<[^>]+>|void|String|int|bool|dynamic)\s+(\w+)\s*\(([^)]*)\)/m],
        classPatterns: [/(?:class|abstract class|mixin|enum)\s+(\w+)/m],
        exportPatterns: [],
    },
    ruby: {
        importPatterns: [/^(?:require|require_relative)\s+'([^']+)'/],
        functionPatterns: [/^\s*def\s+(\w+)(?:\(([^)]*)\))?/m],
        classPatterns: [/^(?:class|module)\s+(\w+)/m],
        exportPatterns: [],
    },
    php: {
        importPatterns: [/^(?:require|require_once|include|use)\s+['"]?([^;'"]+)/],
        functionPatterns: [/function\s+(\w+)\s*\(([^)]*)\)/m],
        classPatterns: [/(?:class|interface|trait|abstract class)\s+(\w+)/m],
        exportPatterns: [],
    },
    c: {
        importPatterns: [/^#include\s+[<"]([^>"]+)[>"]/],
        functionPatterns: [/^\s*[\w*]+\s+(\w+)\s*\(([^)]*)\)\s*\{/m],
        classPatterns: [/^typedef\s+struct\s+(\w*)\s*\{/m],
        exportPatterns: [],
    },
    cpp: {
        importPatterns: [/^#include\s+[<"]([^>"]+)[>"]/],
        functionPatterns: [/^\s*[\w*:<>]+\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?\{/m],
        classPatterns: [/^(?:class|struct)\s+(\w+)/m],
        exportPatterns: [],
    },
    html: {
        importPatterns: [/<script\s+src=["']([^"']+)["']/],
        functionPatterns: [],
        classPatterns: [],
        exportPatterns: [],
    },
    css: {
        importPatterns: [/@import\s+['"]([^'"]+)['"]/],
        functionPatterns: [],
        classPatterns: [/^\.([\w-]+)\s*\{/m],
        exportPatterns: [],
    },
    scss: {
        importPatterns: [/@(?:import|use|forward)\s+['"]([^'"]+)['"]/],
        functionPatterns: [/@mixin\s+([\w-]+)/m],
        classPatterns: [/^\.([\w-]+)\s*\{/m],
        exportPatterns: [],
    },
};

function makeLocation(line: number, filePath: string): SourceLocation {
    return {
        file: filePath,
        start: { line, column: 0 },
        end: { line, column: 0 },
    };
}

export class GenericAnalyzer {
    analyze(filePath: string, language: Language): GenericParseResult {
        let source: string;
        try {
            source = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return {
                language, hash: '', imports: [], exports: [], functions: [], classes: [],
                errors: [`Cannot read file: ${String(err)}`],
            };
        }

        const hash = contentHash(source);
        const patterns = LANGUAGE_PATTERNS[language];

        if (!patterns) {
            return { language, hash, imports: [], exports: [], functions: [], classes: [], errors: [] };
        }

        const lines = source.split('\n');
        const imports: ParsedImport[] = [];
        const functions: ParsedFunction[] = [];
        const classes: ParsedClass[] = [];
        const exports_: ParsedExport[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;

            for (const pattern of patterns.importPatterns) {
                const match = line.match(pattern);
                if (match?.[1]) {
                    imports.push({
                        source: match[1],
                        specifiers: [],
                        isDefault: false,
                        isNamespace: false,
                    });
                }
            }

            for (const pattern of patterns.functionPatterns) {
                const match = line.match(pattern);
                if (match?.[1]) {
                    const params = match[2]
                        ? match[2].split(',').map(p => p.trim().split(/[\s:]/)[0] ?? 'unknown').filter(Boolean)
                        : [];
                    functions.push({
                        name: match[1],
                        params,
                        isAsync: line.includes('async'),
                        isExported: line.includes('pub ') || line.includes('export') || line.includes('public'),
                        location: makeLocation(i + 1, filePath),
                        calls: [],
                        usesTypes: [],
                    });
                }
            }

            for (const pattern of patterns.classPatterns) {
                const match = line.match(pattern);
                if (match?.[1]) {
                    classes.push({
                        name: match[1],
                        implements: [],
                        methods: [],
                        properties: [],
                        isExported: line.includes('pub ') || line.includes('export') || line.includes('public'),
                        location: makeLocation(i + 1, filePath),
                    });
                }
            }

            for (const pattern of patterns.exportPatterns) {
                const match = line.match(pattern);
                if (match?.[1]) {
                    exports_.push({ name: match[1], kind: 'variable', isDefault: false });
                }
            }
        }

        return { language, hash, imports, exports: exports_, functions, classes, errors: [] };
    }
}
