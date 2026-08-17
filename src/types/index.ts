import { z } from 'zod';

// ─── Graph Types ──────────────────────────────────────────────────────────────

export type NodeKind =
    | 'file'
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'variable'
    | 'api_endpoint'
    | 'db_table'
    | 'db_column'
    | 'component'
    | 'hook'
    | 'route'
    | 'config'
    | 'test'
    | 'schema'
    | 'query'
    | 'mutation';

export type EdgeKind =
    | 'imports'
    | 'exports'
    | 'calls'
    | 'extends'
    | 'implements'
    | 'uses_type'
    | 'reads_from'
    | 'writes_to'
    | 'provides'
    | 'tests'
    | 'depends_on'
    | 'references'
    | 'api_uses'
    | 'db_uses'
    | 'renders';

export type Layer = 'database' | 'backend' | 'api' | 'frontend' | 'config' | 'infrastructure' | 'unknown';

export type Language =
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'csharp'
    | 'kotlin'
    | 'swift'
    | 'dart'
    | 'ruby'
    | 'php'
    | 'c'
    | 'cpp'
    | 'html'
    | 'css'
    | 'scss'
    | 'sql'
    | 'graphql'
    | 'yaml'
    | 'json'
    | 'dockerfile'
    | 'mixed'
    | 'unknown';

export interface SourceLocation {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

export interface GraphNode {
    id: string;
    kind: NodeKind;
    name: string;
    filePath: string;
    layer: Layer;
    language: Language;
    signature?: string;
    docComment?: string;
    location?: SourceLocation;
    metadata: Record<string, unknown>;
    embedding?: number[];
    hash: string;
    createdAt: number;
    updatedAt: number;
}

export interface GraphEdge {
    id: string;
    kind: EdgeKind;
    sourceId: string;
    targetId: string;
    weight: number;
    metadata: Record<string, unknown>;
    createdAt: number;
}

// ─── Impact Types ─────────────────────────────────────────────────────────────

export interface TriggerChange {
    filePath: string;
    nodeId?: string;
    changeType: 'create' | 'modify' | 'delete' | 'rename';
    description?: string;
}

export interface ImpactedNode {
    node: GraphNode;
    depth: number;
    path: string[];
    reason: string;
    confidence: number;
}

export interface CrossLayerIssue {
    sourceLayer: Layer;
    targetLayer: Layer;
    sourceNode: string;
    targetNode: string;
    edgeKind: EdgeKind;
    severity: 'info' | 'warning' | 'error';
    message: string;
}

export interface ImpactReport {
    id: string;
    triggerChange: TriggerChange;
    impactedNodes: ImpactedNode[];
    affectedLayers: Layer[];
    severity: 'low' | 'medium' | 'high' | 'critical';
    scope: {
        files: string[];
        functions: string[];
        apiEndpoints: string[];
        dbTables: string[];
        components: string[];
    };
    crossLayerIssues: CrossLayerIssue[];
    timestamp: number;
    summary: string;
}

// ─── Diagnostics Types ────────────────────────────────────────────────────────

export interface Diagnostic {
    file: string;
    line: number;
    column: number;
    message: string;
    code?: string;
    severity: 'error' | 'warning';
    tool: string;
}

export interface DiagnosticReport {
    errors: Diagnostic[];
    warnings: Diagnostic[];
    tool: string;
    durationMs: number;
}

export interface FailureSnapshot {
    id: string;
    category: 'compile_error' | 'runtime_crash' | 'test_regression' | 'parse_error' | 'logic_drift';
    filePath: string;
    signature?: string;
    message: string;
    stackTrace?: string;
    contextBefore: string;
    timestamp: number;
    frequency: number;
}

export interface Hypothesis {
    id: string;
    description: string;
    logicLines: string;
    confidence: number;
    impactLevel: 'local' | 'systemic';
    score?: number;
}

export interface RootCauseReport {
    failureId: string;
    primaryCause: string;
    analyzedFiles: string[];
    hypotheses: Hypothesis[];
    chosenSolutionId?: string;
    temporalContext: { hash: string; date: string; message: string }[];
}

export interface StaticFixRule {
    id: string;
    tool: string;
    code?: string;
    messagePattern: string;
    description: string;
}

// ─── AI Orchestration Types ──────────────────────────────────────────────────

export type TaskType = 'simple' | 'analysis' | 'reasoning' | 'design';

export interface ModelRequest {
    taskType: TaskType;
    priority: 'low' | 'medium' | 'high';
    context: string;
    systemPrompt?: string;
    maxTokens: number;
    temperature?: number;
    filePath?: string;
    modelOverride?: string;
}

export interface ModelResponse {
    content: string;
    usage: {
        promptTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
    provider: string;
    model: string;
    cached?: boolean;
}

export type AIProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama';

export interface AIProvider {
    kind: AIProviderKind;
    execute(request: ModelRequest): Promise<ModelResponse>;
    embed?(text: string): Promise<number[]>;
    batchEmbed?(texts: string[]): Promise<number[][]>;
    listModels?(): Promise<string[]>;
    isAvailable(): Promise<boolean>;
}

export interface AICompletionRequest {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    model?: string;
    responseFormat?: 'text' | 'json';
}

export interface AICompletionResponse {
    content: string;
    model: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    provider: AIProviderKind;
}

export interface AITask {
    id: string;
    kind: 'fix' | 'update' | 'generate' | 'refactor' | 'sync' | 'informational';
    description: string;
    targetFile: string;
    targetNodeId?: string;
    context: string;
    constraints: string[];
    expectedOutput: string;
    priority: number;
}

export interface AITaskResult {
    taskId: string;
    success: boolean;
    filePath: string;
    originalContent: string;
    updatedContent: string;
    diff: string;
    confidence: number;
    explanation: string;
    validationErrors: string[];
    appliedAt?: number;
}

// ─── Environment Types ────────────────────────────────────────────────────────

export type ServiceKind = 'backend' | 'frontend' | 'database' | 'cache' | 'queue' | 'proxy';

export interface ServiceConfig {
    name: string;
    kind: ServiceKind;
    image?: string;
    command?: string;
    port: number;
    resolvedPort?: number;
    environment: Record<string, string>;
    volumes?: string[];
    dependsOn?: string[];
    healthCheck?: string;
}

export interface EnvironmentConfig {
    name: string;
    services: ServiceConfig[];
    runtimeVersions: Record<string, string>;
    resolvedAt?: number;
}

export interface RuntimeVersion {
    runtime: string;
    required: string;
    installed?: string;
    compatible: boolean;
    resolution?: string;
}

export interface PortConflict {
    port: number;
    serviceName: string;
    occupiedBy?: string;
    resolvedPort?: number;
}

// ─── Project Config ───────────────────────────────────────────────────────────

export const ProjectConfigSchema = z.object({
    name: z.string(),
    version: z.string().default('1.0.0'),
    rootDir: z.string(),
    dataDir: z.string().default('.cos'),
    language: z.enum([
        'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp',
        'kotlin', 'swift', 'dart', 'ruby', 'php', 'c', 'cpp', 'html', 'css', 'scss',
        'sql', 'graphql', 'yaml', 'json', 'dockerfile', 'mixed', 'unknown',
    ]),
    layers: z.object({
        database: z.array(z.string()).default([]),
        backend: z.array(z.string()).default([]),
        api: z.array(z.string()).default([]),
        frontend: z.array(z.string()).default([]),
    }),
    exclude: z.array(z.string()).default(['node_modules', 'dist', '.git', '.cos', 'coverage', '__pycache__']),
    ai: z.object({
        provider: z.enum(['openai', 'anthropic', 'gemini', 'openrouter', 'ollama']).default('anthropic'),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).default(0.2),
        maxTokens: z.number().default(4096),
    }),
    environment: z.object({
        autoResolvePortConflicts: z.boolean().default(true),
        autoResolveRuntimeVersions: z.boolean().default(true),
        dockerSocket: z.string().default('/var/run/docker.sock'),
    }).default({
        autoResolvePortConflicts: true,
        autoResolveRuntimeVersions: true,
        dockerSocket: '/var/run/docker.sock',
    }),
    watch: z.object({
        debounceMs: z.number().default(500),
        autoAnalyze: z.boolean().default(true),
        autoApply: z.boolean().default(false),
    }).default({
        debounceMs: 500,
        autoAnalyze: true,
        autoApply: false,
    }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ─── Change History ───────────────────────────────────────────────────────────

export type ChangeOperation = 'modify' | 'create' | 'delete' | 'move';

export interface ChangeRecord {
    id: string;
    sessionId: string;
    taskId: string;
    filePath: string;
    originalContent: string;
    updatedContent: string;
    diff: string;
    appliedAt: number;
    rolledBack: boolean;
    rolledBackAt?: number;
    provider: AIProviderKind;
    confidence: number;
    impactReportId?: string;
    operation?: ChangeOperation;
    /** Original path for move operations; `filePath` is the destination path. */
    sourcePath?: string;
}

// ─── Scanner Types ────────────────────────────────────────────────────────────

export interface ParsedFunction {
    name: string;
    params: string[];
    returnType?: string;
    isAsync: boolean;
    isExported: boolean;
    location: SourceLocation;
}

export interface ParsedClass {
    name: string;
    extends?: string;
    implements: string[];
    methods: ParsedFunction[];
    isExported: boolean;
    location: SourceLocation;
}

export interface ParsedInterface {
    name: string;
    extends: string[];
    isExported: boolean;
    location: SourceLocation;
}

export interface ParsedImport {
    source: string;
    specifiers: string[];
    isTypeOnly: boolean;
}

export interface ParsedExport {
    name: string;
    source?: string;
    isDefault: boolean;
}

export interface APIEndpoint {
    method: string;
    path: string;
    handler?: string;
    location: SourceLocation;
}

export interface FileAnalysis {
    filePath: string;
    language: Language;
    layer: Layer;
    imports: ParsedImport[];
    exports: ParsedExport[];
    functions: ParsedFunction[];
    classes: ParsedClass[];
    interfaces: ParsedInterface[];
    apiEndpoints: APIEndpoint[];
    dbTables: string[];
    errors: string[];
    hash: string;
}

// ─── Synchronization Types ────────────────────────────────────────────────────

export interface SyncIssue {
    id: string;
    type: string;
    severity: 'info' | 'warning' | 'error';
    sourceFile: string;
    targetFile?: string;
    message: string;
    autoFixable: boolean;
}

export interface SyncReport {
    id: string;
    timestamp: number;
    issues: SyncIssue[];
    autoFixed: SyncIssue[];
    requiresManual: SyncIssue[];
    summary: string;
}
