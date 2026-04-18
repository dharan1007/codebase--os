import { z } from 'zod';

// ─── Node Types ──────────────────────────────────────────────────────────────

export type NodeKind =
    | 'file'
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'variable'
    | 'constant'
    | 'enum'
    | 'api_endpoint'
    | 'db_table'
    | 'db_column'
    | 'db_relation'
    | 'component'
    | 'hook'
    | 'module'
    | 'package';

export type EdgeKind =
    | 'imports'
    | 'exports'
    | 'calls'
    | 'extends'
    | 'implements'
    | 'uses_type'
    | 'reads_from'
    | 'writes_to'
    | 'depends_on'
    | 'provides'
    | 'references'
    | 'api_uses'
    | 'db_uses'
    | 'renders';

export type Layer = 'database' | 'backend' | 'api' | 'frontend' | 'config' | 'infrastructure';

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
    | 'unknown';

export interface Position {
    line: number;
    column: number;
}

export interface SourceLocation {
    file: string;
    start: Position;
    end: Position;
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

export interface RelationshipGraph {
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    adjacency: Map<string, Set<string>>;
    reverseAdjacency: Map<string, Set<string>>;
}

// ─── Change Types ─────────────────────────────────────────────────────────────

export type ChangeType =
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'moved';

export type ChangeSeverity = 'breaking' | 'major' | 'minor' | 'patch';

export type ChangeScope =
    | 'schema'
    | 'api_contract'
    | 'type_definition'
    | 'business_logic'
    | 'configuration'
    | 'dependency'
    | 'ui_component'
    | 'test'
    | 'documentation';

export interface FileChange {
    id: string;
    filePath: string;
    changeType: ChangeType;
    oldContent?: string;
    newContent?: string;
    timestamp: number;
    diff?: string;
}

export interface ImpactedNode {
    node: GraphNode;
    reason: string;
    severity: ChangeSeverity;
    propagationDepth: number;
    requiresUpdate: boolean;
    suggestedAction?: string;
}

export interface ImpactReport {
    id: string;
    triggerChange: FileChange;
    impactedNodes: ImpactedNode[];
    affectedLayers: Layer[];
    severity: ChangeSeverity;
    scope: ChangeScope[];
    crossLayerIssues: CrossLayerIssue[];
    timestamp: number;
    summary: string;
}

export interface CrossLayerIssue {
    description: string;
    sourceLayer: Layer;
    targetLayer: Layer;
    severity: ChangeSeverity;
    affectedNodeIds: string[];
    resolution?: string;
    autoFixable?: boolean;
}

// ─── AI Provider Types ────────────────────────────────────────────────────────

export type AIProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama';

export interface AIProvider {
    kind: AIProviderKind;
    complete(request: AICompletionRequest): Promise<AICompletionResponse>;
    completeStream?(request: AICompletionRequest, onToken: (token: string) => void): Promise<AICompletionResponse>;
    embed?(text: string): Promise<number[]>;
    batchEmbed?(texts: string[]): Promise<number[][]>;
    isAvailable(): Promise<boolean>;
    listModels?(): Promise<string[]>;
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
        'sql', 'graphql', 'yaml', 'json', 'dockerfile', 'mixed', 'unknown'
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
        dockerSocket: '/var/run/docker.sock'
    }),
    watch: z.object({
        debounceMs: z.number().default(500),
        autoAnalyze: z.boolean().default(true),
        autoApply: z.boolean().default(false),
    }).default({
        debounceMs: 500,
        autoAnalyze: true,
        autoApply: false
    }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ─── Change History ───────────────────────────────────────────────────────────

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
}

// ─── Scanner Types ────────────────────────────────────────────────────────────

export interface ParsedFunction {
    name: string;
    params: string[];
    returnType?: string;
    isAsync: boolean;
    isExported: boolean;
    docComment?: string;
    location: SourceLocation;
    calls: string[];
    usesTypes: string[];
}

export interface ParsedClass {
    name: string;
    extends?: string;
    implements: string[];
    methods: ParsedFunction[];
    properties: ParsedProperty[];
    isExported: boolean;
    docComment?: string;
    location: SourceLocation;
}

export interface ParsedProperty {
    name: string;
    type?: string;
    optional: boolean;
    readonly: boolean;
    location: SourceLocation;
}

export interface ParsedInterface {
    name: string;
    extends: string[];
    properties: ParsedProperty[];
    methods: ParsedFunction[];
    isExported: boolean;
    location: SourceLocation;
}

export interface ParsedImport {
    source: string;
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
    resolvedPath?: string;
}

export interface ParsedExport {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'default' | 're-export';
    isDefault: boolean;
}

export interface ParsedAPIEndpoint {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
    path: string;
    handler: string;
    middleware: string[];
    requestBody?: string;
    responseType?: string;
    location: SourceLocation;
}

export interface ParsedDBSchema {
    tableName: string;
    columns: ParsedDBColumn[];
    relations: ParsedDBRelation[];
    location: SourceLocation;
}

export interface ParsedDBColumn {
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    unique: boolean;
    defaultValue?: string;
    references?: { table: string; column: string };
}

export interface ParsedDBRelation {
    kind: 'one-to-one' | 'one-to-many' | 'many-to-many';
    targetTable: string;
    foreignKey: string;
    joinTable?: string;
}

export interface FileAnalysis {
    filePath: string;
    language: Language;
    layer: Layer;
    hash: string;
    imports: ParsedImport[];
    exports: ParsedExport[];
    functions: ParsedFunction[];
    classes: ParsedClass[];
    interfaces: ParsedInterface[];
    types: Array<{ name: string; definition: string; location: SourceLocation; isExported: boolean }>;
    variables: Array<{ name: string; type?: string; isConst: boolean; isExported: boolean; location: SourceLocation }>;
    apiEndpoints: ParsedAPIEndpoint[];
    dbSchemas: ParsedDBSchema[];
    analyzedAt: number;
    errors: string[];
}

// ─── Sync Types ───────────────────────────────────────────────────────────────

export interface SyncIssue {
    id: string;
    kind: 'type_mismatch' | 'missing_field' | 'broken_reference' | 'schema_drift' | 'api_drift';
    description: string;
    sourceFile: string;
    targetFile?: string;
    sourceNodeId: string;
    targetNodeId?: string;
    severity: ChangeSeverity;
    autoFixable: boolean;
    suggestedFix?: string;
}

export interface SyncReport {
    id: string;
    timestamp: number;
    issues: SyncIssue[];
    autoFixed: SyncIssue[];
    requiresManualFix: SyncIssue[];
    summary: string;
}