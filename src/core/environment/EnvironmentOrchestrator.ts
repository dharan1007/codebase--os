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
    dependencyStatus: { success: boolean; missing: string[]; error?: string; packageManager?: string; installPresent?: boolean };
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

    /** Inspect the environment. This method is intentionally read-only. */
    async initialize(): Promise<OrchestratorReport> {
        logger.info('Inspecting development environment...');
        const envConfig = await this.loadEnvironmentConfig();
        const portConflicts = await this.portManager.resolveConflicts(
            envConfig.services.map(service => ({ serviceName: service.name, port: service.port })),
        );

        for (const conflict of portConflicts) {
            const service = envConfig.services.find(candidate => candidate.name === conflict.serviceName);
            if (service && conflict.resolvedPort) service.resolvedPort = conflict.resolvedPort;
        }

        const runtimeVersions = await this.runtimeVersionManager.checkAll(this.config.rootDir);
        const dependencies = await this.dependencyManager.check();
        const dependencyStatus: OrchestratorReport['dependencyStatus'] = {
            success: dependencies.success,
            missing: dependencies.missing,
            error: dependencies.error,
            packageManager: dependencies.packageManager,
            installPresent: dependencies.installPresent,
        };

        const dockerAvailable = await this.dockerManager.isAvailable();
        const containerStatuses: OrchestratorReport['containerStatuses'] = [];
        if (dockerAvailable) {
            for (const service of envConfig.services.filter(service => service.image)) {
                const status = await this.dockerManager.getContainerStatus(service.name);
                containerStatuses.push({ name: service.name, status: status?.status ?? 'not found' });
            }
        }

        envConfig.resolvedAt = Date.now();
        logger.info('Environment inspection complete', {
            portConflicts: portConflicts.length,
            runtimeVersions: runtimeVersions.length,
            dockerAvailable,
            dependenciesReady: dependencyStatus.success,
        });

        return { portConflicts, runtimeVersions, dependencyStatus, dockerAvailable, containerStatuses, resolvedConfig: envConfig };
    }

    /** Explicit dependency installation; never called by initialize/check. */
    async installDependencies(): Promise<{ success: boolean; output: string; error?: string }> {
        return this.dependencyManager.install();
    }

    async startServices(envConfig: EnvironmentConfig): Promise<Array<{ name: string; success: boolean }>> {
        const results: Array<{ name: string; success: boolean }> = [];
        const dockerAvailable = await this.dockerManager.isAvailable();

        for (const service of envConfig.services) {
            if (!service.image || !dockerAvailable) {
                if (!dockerAvailable) logger.warn('Docker not available, cannot start container', { service: service.name });
                results.push({ name: service.name, success: false });
                continue;
            }

            const existing = await this.dockerManager.getContainerStatus(service.name);
            if (existing?.status === 'running') {
                results.push({ name: service.name, success: true });
                continue;
            }

            if (existing) {
                results.push({ name: service.name, success: await this.dockerManager.startContainer(service.name) });
                continue;
            }

            try {
                await this.dockerManager.pullImage(service.image);
                results.push({ name: service.name, success: await this.dockerManager.createAndStartContainer(service) });
            } catch (err) {
                logger.error('Failed to create environment service', { service: service.name, error: String(err) });
                results.push({ name: service.name, success: false });
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
                const parsed = yaml.parse(fs.readFileSync(candidate, 'utf8'));
                if (parsed && typeof parsed === 'object') return this.normalizeEnvironmentConfig(parsed as Record<string, unknown>);
            } catch (err) {
                logger.warn('Environment configuration could not be parsed', { candidate, error: String(err) });
            }
        }
        return { name: this.config.name, services: [], runtimeVersions: {} };
    }

    private normalizeEnvironmentConfig(raw: Record<string, unknown>): EnvironmentConfig {
        const services: ServiceConfig[] = [];
        const rawServices = raw['services'];
        if (rawServices && typeof rawServices === 'object' && !Array.isArray(rawServices)) {
            for (const [name, svcRaw] of Object.entries(rawServices as Record<string, unknown>)) {
                if (!svcRaw || typeof svcRaw !== 'object' || Array.isArray(svcRaw)) continue;
                const svc = svcRaw as Record<string, unknown>;
                const portsRaw = Array.isArray(svc['ports']) ? svc['ports'] : [];
                let port = 3000;
                if (portsRaw.length > 0) {
                    const first = String(portsRaw[0]);
                    const parts = first.split(':');
                    const parsed = Number.parseInt(parts[parts.length - 1] ?? '', 10);
                    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
                }

                const environment: Record<string, string> = {};
                const envRaw = svc['environment'];
                if (Array.isArray(envRaw)) {
                    for (const entry of envRaw) {
                        const [key, ...rest] = String(entry).split('=');
                        if (key) environment[key] = rest.join('=');
                    }
                } else if (envRaw && typeof envRaw === 'object') {
                    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
                        environment[key] = value == null ? '' : String(value);
                    }
                }

                const dependsOnRaw = svc['depends_on'];
                const dependsOn = Array.isArray(dependsOnRaw)
                    ? dependsOnRaw.map(String)
                    : dependsOnRaw && typeof dependsOnRaw === 'object'
                        ? Object.keys(dependsOnRaw as Record<string, unknown>)
                        : [];

                services.push({
                    name,
                    kind: this.guessServiceKind(name, typeof svc['image'] === 'string' ? svc['image'] : undefined),
                    image: typeof svc['image'] === 'string' ? svc['image'] : undefined,
                    command: typeof svc['command'] === 'string' ? svc['command'] : undefined,
                    port,
                    environment,
                    volumes: Array.isArray(svc['volumes']) ? svc['volumes'].map(String) : [],
                    dependsOn,
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

    generateDockerCompose(envConfig: EnvironmentConfig): string {
        return this.dockerManager.generateDockerCompose(envConfig);
    }
}
