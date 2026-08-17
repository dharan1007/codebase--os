import type { ModelRequest, ProjectConfig, AIProviderKind, AIProvider, TaskType } from '../../types/index.js';
import { Database } from '../../storage/Database.js';
import { ResourceMonitor } from './ResourceMonitor.js';
import { AIProviderFactory } from '../ai/AIProviderFactory.js';
import { type SemanticModelSlug, ModelRegistry } from '../ai/ModelRegistry.js';
import { HotHealthTracker } from './HotHealthTracker.js';

export interface ProviderSelection {
    provider: AIProviderKind;
    model: string;
    tier: 1 | 2 | 3;
}

const CLOUD_PROVIDERS: AIProviderKind[] = ['openai', 'anthropic', 'gemini', 'openrouter'];

export class ModelRouter {
    private health: HotHealthTracker;

    constructor(
        private config: ProjectConfig,
        private db: Database,
        private monitor: ResourceMonitor,
    ) {
        this.health = HotHealthTracker.getInstance();
    }

    getProviderForTask(taskType: string): AIProvider {
        const semanticRole = this.semanticRole(taskType);
        const supportedTaskType: TaskType = this.toTaskType(taskType);
        const chain = this.selectProvider({
            taskType: supportedTaskType,
            priority: 'medium',
            context: 'provider-selection',
            maxTokens: 2000,
        });

        const configuredProvider = this.config.ai.provider as AIProviderKind;
        const fallback: ProviderSelection = {
            provider: configuredProvider,
            model: this.config.ai.model || ModelRegistry.resolve(semanticRole, configuredProvider),
            tier: 1,
        };
        const best = chain[0] ?? fallback;
        return AIProviderFactory.createRaw(best.provider, best.model);
    }

    /**
     * Builds a provider-diverse chain for the semantic task role. Model IDs are
     * resolved by ModelRegistry/environment config instead of a hardcoded model
     * leaderboard that becomes stale between releases.
     */
    selectProvider(request: ModelRequest): ProviderSelection[] {
        const candidates = this.getCandidatePool(request.taskType);
        const available = candidates.filter(candidate => {
            if (!this.checkKeyAvailability(candidate.provider)) return false;
            if (!this.health.isAvailable(candidate.provider, candidate.model)) return false;
            return this.monitor.canExecute(candidate.provider).allowed;
        });

        const sorted = available.sort((a, b) => {
            const preferredA = a.provider === this.config.ai.provider ? 12 : 0;
            const preferredB = b.provider === this.config.ai.provider ? 12 : 0;
            const scoreA = this.health.getScore(a.provider, a.model) + preferredA - a.tier * 20;
            const scoreB = this.health.getScore(b.provider, b.model) + preferredB - b.tier * 20;
            return scoreB - scoreA || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
        });

        const unique: ProviderSelection[] = [];
        const seen = new Set<string>();
        for (const candidate of sorted) {
            const key = `${candidate.provider}:${candidate.model}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(candidate);
        }

        if (unique.length >= 2 && unique[0]!.provider === unique[1]!.provider) {
            const differentIndex = unique.findIndex((candidate, index) =>
                index > 0 && candidate.provider !== unique[0]!.provider,
            );
            if (differentIndex > 1) {
                const [different] = unique.splice(differentIndex, 1);
                unique.splice(1, 0, different!);
            }
        }

        return unique;
    }

    private getCandidatePool(taskType: TaskType | string): ProviderSelection[] {
        const semanticRole = this.semanticRole(taskType);
        const pool: ProviderSelection[] = [];
        const configuredProvider = this.config.ai.provider as AIProviderKind;

        if (this.config.ai.model) {
            pool.push({
                provider: configuredProvider,
                model: this.config.ai.model,
                tier: 1,
            });
        }

        const providers: AIProviderKind[] = [
            configuredProvider,
            ...CLOUD_PROVIDERS.filter(provider => provider !== configuredProvider),
            'ollama',
        ];

        for (const provider of providers) {
            try {
                pool.push({
                    provider,
                    model: ModelRegistry.resolve(semanticRole, provider),
                    tier: provider === configuredProvider ? 1 : provider === 'ollama' ? 3 : 2,
                });
            } catch {
                // Semantic role intentionally unsupported for this provider.
            }
        }

        return pool;
    }

    private semanticRole(taskType: TaskType | string): SemanticModelSlug {
        if (taskType === 'simple') return 'reasoning-fast';
        if (taskType === 'analysis' || taskType === 'sync') return 'analysis-fast';
        if (taskType === 'design') return 'design-premium';
        return 'reasoning-high';
    }

    private toTaskType(taskType: string): TaskType {
        if (taskType === 'simple' || taskType === 'analysis' || taskType === 'reasoning' || taskType === 'design') {
            return taskType;
        }
        if (taskType === 'sync') return 'analysis';
        return 'reasoning';
    }

    private checkKeyAvailability(provider: AIProviderKind): boolean {
        if (provider === 'ollama') return true;
        const keyMap: Partial<Record<AIProviderKind, string | undefined>> = {
            openai: process.env['OPENAI_API_KEY'],
            anthropic: process.env['ANTHROPIC_API_KEY'],
            gemini: process.env['GEMINI_API_KEY'],
            openrouter: process.env['OPENROUTER_API_KEY'],
        };
        const key = keyMap[provider];
        return Boolean(key?.trim());
    }
}
