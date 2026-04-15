import path from 'path';
import fs from 'fs';
import type { EnvironmentConfig, ServiceConfig, ProjectConfig, PortConflict, RuntimeVersion } from '../../types/index.js';
import { PortManager } from './PortManager.js';
import { RuntimeVersionManager } from './RuntimeVersionManager.js';
import { DependencyManager } from './DependencyManager.js';
import { DockerManager } from './DockerManager.js';
import yaml from 'yaml';
import { logger } from '../../utils/logger.js';

export interface OrchestratorReport {
    portConflicts: PortConflict[];
    runtimeVersions: RuntimeVersion[];
    dependencyStatus: { success: boolean; missing: string[]; error?: string };
    dockerAvailable: boolean;
    containerStatuses: Array<{ name: string; status: string }>;
    resolvedConfig: EnvironmentConfig;
}

export class EnvironmentOrchestrator {
    private portManager: PortManager;
    private runtimeVersionManager: RuntimeVersionManager;
    private dependencyManager: DependencyManager;
    private dockerManager: DockerManager;

    constructor(private config: ProjectConfig) {
        this.portManager = new PortManager();
        this.runtimeVersionManager = new RuntimeVersionManager();
        this.dependencyManager = new DependencyManager(config.rootDir);
        this.dockerManager = new DockerManager(config.environment.dockerSocket);
    }

    async initialize(): Promise<OrchestratorReport> {
        logger.info('Initializing environment...');

        const envConfig = await this.loadEnvironmentConfig();

        const portConflicts = await this.portManager.resolveConflicts(
            envConfig.services.map(s => ({ serviceName: s.name, port: s.port }))
        );

        for (const conflict of portConflicts) {
            const service = envConfig.services.find(s => s.name === conflict.serviceName);
            if (service && conflict.resolvedPort) {
                service.resolvedPort = conflict.resolvedPort;
            }
        }

        const runtimeVersions = await this.runtimeVersionManager.checkAll(this.config.rootDir);

        const dependencyStatus = await this.checkAndInstallDependencies();

        const dockerAvailable = await this.dockerManager.isAvailable();
        const containerStatuses: OrchestratorReport['containerStatuses'] = [];

        if (dockerAvailable) {
            for (const service of envConfig.services.filter(s => s.image)) {
                const status = await this.dockerManager.getContainerStatus(service.name);
                containerStatuses.push({ name: service.name, status: status?.status ?? 'not found' });
            }
        }

        envConfig.resolvedAt = Date.now();

        logger.info('Environment initialization complete', {
            portConflicts: portConflicts.length,
            runtimeVersions: runtimeVersions.length,
            dockerAvailable,
        });

        return {
            portConflicts,
            runtimeVersions,
            dependencyStatus,
            dockerAvailable,
            containerStatuses,
            resolvedConfig: envConfig,
        };
    }

    async startServices(envConfig: EnvironmentConfig): Promise<Array<{ name: string; success: boolean }>> {
        const results: Array<{ name: string; success: boolean }> = [];
        const dockerAvailable = await this.dockerManager.isAvailable();

        for (const service of envConfig.services) {
            if (!service.image) {
                results.push({ name: service.name, success: false });
                continue;
            }

            if (!dockerAvailable) {
                logger.warn('Docker not available, cannot start container', { service: service.name });
                results.push({ name: service.name, success: false });
                continue;
            }

            const existing = await this.dockerManager.getContainerStatus(service.name);
            if (existing?.status === 'running') {
                logger.info('Container already running', { name: service.name });
                results.push({ name: service.name, success: true });
                continue;
            }

            if (existing) {
                const started = await this.dockerManager.startContainer(service.name);
                results.push({ name: service.name, success: started });
            } else {
                await this.dockerManager.pullImage(service.image);
                const created = await this.dockerManager.createAndStartContainer(service);
                results.push({ name: service.name, success: created });
            }
        }

        return results;
    }

    private async loadEnvironmentConfig(): Promise<EnvironmentConfig> {
        const candidates = [
            path.join(this.config.rootDir, '.cos', 'environment.yaml'),
            path.join(this.config.rootDir, 'docker-compose.yaml'),
            path.join(this.config.rootDir, 'docker-compose.yml'),
        ];

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            try {
                const content = fs.readFileSync(candidate, 'utf8');
                const parsed = yaml.parse(content);
                return this.normalizeEnvironmentConfig(parsed, candidate);
            } catch { continue; }
        }

        return { name: this.config.name, services: [], runtimeVersions: {} };
    }

    private normalizeEnvironmentConfig(raw: Record<string, unknown>, sourceFile: string): EnvironmentConfig {
        const services: ServiceConfig[] = [];

        if (raw['services']) {
            for (const [name, svcRaw] of Object.entries(raw['services'] as Record<string, unknown>)) {
                const svc = svcRaw as Record<string, unknown>;
                const portsRaw = (svc['ports'] as string[] | undefined) ?? [];
                let port = 3000;

                if (portsRaw.length > 0) {
                    const firstPort = portsRaw[0]!;
                    const portStr = typeof firstPort === 'string' ? firstPort : String(firstPort);
                    const parts = portStr.split(':');
                    port = parseInt(parts[parts.length - 1]!, 10) || port;
                }

                const envRaw = svc['environment'] as string[] | Record<string, string> | undefined;
                const environment: Record<string, string> = {};
                if (Array.isArray(envRaw)) {
                    for (const e of envRaw) {
                        const [k, v] = (e as string).split('=');
                        if (k) environment[k] = v ?? '';
                    }
                } else if (envRaw && typeof envRaw === 'object') {
                    Object.assign(environment, envRaw);
                }

                services.push({
                    name,
                    kind: this.guessServiceKind(name, svc['image'] as string | undefined),
                    image: svc['image'] as string | undefined,
                    command: svc['command'] as string | undefined,
                    port,
                    environment,
                    volumes: (svc['volumes'] as string[] | undefined) ?? [],
                    dependsOn: (svc['depends_on'] as string[] | undefined) ?? [],
                });
            }
        }

        return { name: path.basename(this.config.rootDir), services, runtimeVersions: {} };
    }

    private guessServiceKind(name: string, image?: string): ServiceConfig['kind'] {
        const combined = `${name} ${image ?? ''}`.toLowerCase();
        if (combined.includes('postgres') || combined.includes('mysql') || combined.includes('mongo') || combined.includes('db')) return 'database';
        if (combined.includes('redis') || combined.includes('memcached') || combined.includes('cache')) return 'cache';
        if (combined.includes('rabbit') || combined.includes('kafka') || combined.includes('queue') || combined.includes('nats')) return 'queue';
        if (combined.includes('nginx') || combined.includes('proxy') || combined.includes('traefik')) return 'proxy';
        if (combined.includes('frontend') || combined.includes('web') || combined.includes('client')) return 'frontend';
        return 'backend';
    }

    private async checkAndInstallDependencies(): Promise<OrchestratorReport['dependencyStatus']> {
        const result = await this.dependencyManager.install();
        return {
            success: result.success,
            missing: [],
            error: result.error,
        };
    }

    generateDockerCompose(envConfig: EnvironmentConfig): string {
        return this.dockerManager.generateDockerCompose(envConfig);
    }
}