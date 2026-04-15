import type { AITaskResult } from '../../types/index.js';
import { TypeScriptValidator } from '../../utils/validation.js';
import { parseBabel } from '../../utils/ast.js';
import { detectLanguage } from '../../utils/ast.js';
import { logger } from '../../utils/logger.js';

export class ChangeValidator {
    private tsValidator: TypeScriptValidator;

    constructor(rootDir: string) {
        this.tsValidator = new TypeScriptValidator(rootDir);
    }

    validate(result: AITaskResult): AITaskResult {
        const language = detectLanguage(result.filePath);
        const errors: string[] = [...result.validationErrors];

        if (language === 'typescript' || language === 'javascript') {
            const syntaxErrors = this.validateJSSyntax(result.updatedContent, result.filePath);
            errors.push(...syntaxErrors);

            if (language === 'typescript' && syntaxErrors.length === 0) {
                const typeErrors = this.tsValidator.validateFile(result.filePath, result.updatedContent);
                const criticalTypeErrors = typeErrors.errors.filter(e => e.code < 2500);
                errors.push(...criticalTypeErrors.map(e => `TS${e.code} at line ${e.line}: ${e.message}`));
            }
        }

        if (language === 'json' || result.filePath.endsWith('.json')) {
            try {
                JSON.parse(result.updatedContent);
            } catch (err) {
                errors.push(`Invalid JSON: ${String(err)}`);
            }
        }

        const confidence = this.computeConfidence(result, errors);

        return {
            ...result,
            validationErrors: errors,
            success: errors.length === 0,
            confidence,
        };
    }


    private validateJSSyntax(content: string, filePath: string): string[] {
        const ast = parseBabel(content, filePath);
        if (!ast) return [`Syntax error: Failed to parse file`];

        const errors: string[] = [];
        const astErrors = (ast.ast as any).errors || [];
        for (const error of astErrors) {
            errors.push(`Syntax error at line ${error.loc?.line ?? 0}: ${error.message}`);
        }
        return errors;
    }

    private computeConfidence(result: AITaskResult, validationErrors: string[]): number {
        let confidence = result.confidence;

        if (validationErrors.length > 0) {
            confidence -= validationErrors.length * 0.1;
        }

        if (result.updatedContent.trim() === result.originalContent.trim()) {
            confidence = 0.1;
        }

        const diffLines = result.diff.split('\n').length;
        if (diffLines > 100) confidence -= 0.1;
        if (diffLines > 300) confidence -= 0.2;

        if (
            result.updatedContent.includes('TODO') ||
            result.updatedContent.includes('FIXME') ||
            result.updatedContent.includes('PLACEHOLDER')
        ) {
            confidence -= 0.15;
        }

        return Math.max(0, Math.min(1, confidence));
    }
}