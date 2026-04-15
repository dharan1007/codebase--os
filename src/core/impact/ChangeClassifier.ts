import type { FileChange, ChangeScope, ChangeSeverity, Language } from '../../types/index.js';
import { detectLanguage } from '../../utils/ast.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';

export interface ClassifiedChange {
    fileChange: FileChange;
    scopes: ChangeScope[];
    severity: ChangeSeverity;
    breakingChanges: Array<{ kind: string; name: string; description: string }>;
    affectedAPIs: string[];
    affectedSchemas: string[];
    isTypeChange: boolean;
    isSchemaChange: boolean;
    isAPIChange: boolean;
    isConfigChange: boolean;
}

export class ChangeClassifier {
    constructor(private tsAnalyzer: TypeScriptAnalyzer) { }

    classify(change: FileChange): ClassifiedChange {
        const language = detectLanguage(change.filePath);
        const scopes: ChangeScope[] = [];
        let severity: ChangeSeverity = 'patch';
        const breakingChanges: ClassifiedChange['breakingChanges'] = [];
        const affectedAPIs: string[] = [];
        const affectedSchemas: string[] = [];

        const isSchemaChange = this.detectSchemaChange(change);
        const isAPIChange = this.detectAPIChange(change);
        const isTypeChange = this.detectTypeChange(change);
        const isConfigChange = this.detectConfigChange(change);

        if (isSchemaChange) {
            scopes.push('schema');
            severity = this.escalateSeverity(severity, 'major');
            affectedSchemas.push(change.filePath);
        }

        if (isAPIChange) {
            scopes.push('api_contract');
            severity = this.escalateSeverity(severity, 'major');
            affectedAPIs.push(change.filePath);
        }

        if (isTypeChange) {
            scopes.push('type_definition');
            if (
                (language === 'typescript' || language === 'javascript') &&
                change.oldContent &&
                change.newContent
            ) {
                const changes = this.tsAnalyzer.detectTypeBreakingChanges(
                    change.filePath,
                    change.oldContent,
                    change.newContent
                );
                breakingChanges.push(...changes);
                if (breakingChanges.length > 0) {
                    severity = this.escalateSeverity(severity, 'breaking');
                } else {
                    severity = this.escalateSeverity(severity, 'minor');
                }
            }
        }

        if (isConfigChange) {
            scopes.push('configuration');
            severity = this.escalateSeverity(severity, 'minor');
        }

        if (change.changeType === 'deleted') {
            severity = this.escalateSeverity(severity, 'major');
        }

        if (scopes.length === 0) {
            scopes.push('business_logic');
        }

        return {
            fileChange: change,
            scopes,
            severity,
            breakingChanges,
            affectedAPIs,
            affectedSchemas,
            isTypeChange,
            isSchemaChange,
            isAPIChange,
            isConfigChange,
        };
    }

    private detectSchemaChange(change: FileChange): boolean {
        const fp = change.filePath.toLowerCase();
        if (fp.includes('migration') || fp.includes('schema') || fp.endsWith('.sql')) return true;
        if (fp.includes('prisma') || fp.includes('drizzle')) return true;

        const content = change.newContent ?? change.oldContent ?? '';
        const schemaKeywords = [
            /CREATE\s+TABLE/i,
            /ALTER\s+TABLE/i,
            /DROP\s+TABLE/i,
            /\bmodel\s+\w+\s*\{/,
            /@Entity\s*\(/,
            /defineModel\(/,
            /mongoose\.Schema/,
        ];
        return schemaKeywords.some(re => re.test(content));
    }

    private detectAPIChange(change: FileChange): boolean {
        const fp = change.filePath.toLowerCase();
        if (fp.endsWith('.graphql') || fp.endsWith('.gql')) return true;
        if (fp.includes('openapi') || fp.includes('swagger')) return true;
        if (fp.includes('/routes/') || fp.includes('/controllers/')) return true;

        const content = change.newContent ?? change.oldContent ?? '';
        const apiPatterns = [
            /router\.(get|post|put|patch|delete|options)\s*\(/i,
            /app\.(get|post|put|patch|delete|options)\s*\(/i,
            /@(Get|Post|Put|Patch|Delete|Controller)\s*\(/,
            /type\s+Query\s*\{/,
            /type\s+Mutation\s*\{/,
        ];
        return apiPatterns.some(re => re.test(content));
    }

    private detectTypeChange(change: FileChange): boolean {
        const fp = change.filePath.toLowerCase();
        if (fp.includes('/types/') || fp.includes('/interfaces/') || fp.endsWith('.d.ts')) return true;

        const content = change.newContent ?? change.oldContent ?? '';
        const typePatterns = [
            /^export\s+(interface|type|enum)\s+/m,
            /^export\s+type\s+/m,
        ];
        return typePatterns.some(re => re.test(content));
    }

    private detectConfigChange(change: FileChange): boolean {
        const fp = change.filePath.toLowerCase();
        return (
            fp.includes('config') ||
            fp.endsWith('.env') ||
            fp.endsWith('.yaml') ||
            fp.endsWith('.yml') ||
            fp.endsWith('.toml') ||
            fp.endsWith('.json') ||
            fp.includes('tsconfig') ||
            fp.includes('webpack') ||
            fp.includes('vite') ||
            fp.includes('rollup')
        );
    }

    private escalateSeverity(current: ChangeSeverity, candidate: ChangeSeverity): ChangeSeverity {
        const order: ChangeSeverity[] = ['patch', 'minor', 'major', 'breaking'];
        return order.indexOf(candidate) > order.indexOf(current) ? candidate : current;
    }
}