import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { execSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import path from 'path';

export interface TestResult {
    testFile: string;
    success: boolean;
    output: string;
}

export class TestRunner {
    constructor(
        private rootDir: string,
        private graph: RelationshipGraph
    ) {}

    /**
     * Identifies tests impacted by a change to a specific file and runs them.
     */
    async runImpactedTests(filePath: string): Promise<TestResult[]> {
        const testFiles = this.findImpactedTestFiles(filePath);
        const results: TestResult[] = [];

        if (testFiles.size === 0) {
            logger.info('No impacted tests found for file', { filePath });
            return [];
        }

        logger.info(`Running ${testFiles.size} impacted test(s) for ${filePath}`);

        for (const testFile of testFiles) {
            try {
                // Assuming Jest as the default test runner based on package.json
                const output = execSync(`npx jest "${testFile}" --passWithNoTests`, {
                    cwd: this.rootDir,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                results.push({ testFile, success: true, output });
            } catch (err: any) {
                results.push({
                    testFile,
                    success: false,
                    output: String(err?.stdout ?? '') + String(err?.stderr ?? '')
                });
            }
        }

        return results;
    }

    private findImpactedTestFiles(filePath: string): Set<string> {
        const testFiles = new Set<string>();
        const nodesInFile = this.graph.getNodesByFile(filePath);

        for (const node of nodesInFile) {
            // Find all reverse-dependents recursively and check if they are tests
            const allDeps = this.graph.getAllDependents(node.id, 5); // depth of 5
            for (const [depId] of allDeps) {
                const depNode = this.graph.getNode(depId);
                if (depNode && (depNode.filePath.includes('.test.') || depNode.filePath.includes('.spec.'))) {
                    testFiles.add(depNode.filePath);
                }
            }

            // Also check direct incoming edges for 'tests' kind if available
            const incoming = this.graph.getIncomingEdges(node.id);
            for (const edge of incoming) {
                if ((edge.kind as any) === 'tests') {
                    const sourceNode = this.graph.getNode(edge.sourceId);
                    if (sourceNode) testFiles.add(sourceNode.filePath);
                }
            }
        }

        return testFiles;
    }
}
