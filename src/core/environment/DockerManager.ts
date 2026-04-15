import Dockerode from 'dockerode';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import type { ServiceConfig, EnvironmentConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export interface ContainerStatus {
    id: string;
    name: string;
    status: 'running' | 'stopped' | 'exited' | 'created' | 'unknown';
    ports: Record<string, number>;
    health?: string;
}

export class DockerManager {
    private docker: Dockerode;

    constructor(socketPath?: string) {
        this.docker = new Dockerode({ socketPath: socketPath ?? '/var/run/docker.sock' });
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.docker.ping();
            return true;
        } catch {
            return false;
        }
    }

    async getContainerStatus(name: string): Promise<ContainerStatus | null> {
        try {
            const containers = await this.docker.listContainers({ all: true });
            const container = containers.find((c: any) =>
                c.Names.some((n: any) => n === `/${name}` || n === name)
            );

            if (!container) return null;

            const ports: Record<string, number> = {};
            for (const port of container.Ports) {
                if (port.PublicPort) {
                    ports[`${port.PrivatePort}/${port.Type}`] = port.PublicPort;
                }
            }

            return {
                id: container.Id.slice(0, 12),
                name,
                status: this.mapStatus(container.State),
                ports,
                health: container.Status,
            };
        } catch {
            return null;
        }
    }

    async listRunningContainers(): Promise<ContainerStatus[]> {
        try {
            const containers = await this.docker.listContainers();
            return containers.map((c: any) => ({
                id: c.Id.slice(0, 12),
                name: c.Names[0]?.replace(/^\//, '') ?? '',
                status: this.mapStatus(c.State),
                ports: Object.fromEntries(c.Ports.filter((p: any) => p.PublicPort).map((p: any) => [`${p.PrivatePort}/${p.Type}`, p.PublicPort!])),
                health: c.Status,
            }));
        } catch {
            return [];
        }
    }

    async startContainer(name: string): Promise<boolean> {
        try {
            const container = this.docker.getContainer(name);
            await container.start();
            logger.info('Container started', { name });
            return true;
        } catch (err) {
            logger.error('Failed to start container', { name, error: String(err) });
            return false;
        }
    }

    async stopContainer(name: string): Promise<boolean> {
        try {
            const container = this.docker.getContainer(name);
            await container.stop();
            logger.info('Container stopped', { name });
            return true;
        } catch (err) {
            logger.error('Failed to stop container', { name, error: String(err) });
            return false;
        }
    }

    async pullImage(image: string): Promise<boolean> {
        return new Promise(resolve => {
            this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
                if (err) {
                    logger.error('Failed to pull image', { image, error: String(err) });
                    resolve(false);
                    return;
                }
                this.docker.modem.followProgress(stream, (err: Error | null) => {
                    if (err) {
                        logger.error('Image pull failed', { image, error: String(err) });
                        resolve(false);
                    } else {
                        logger.info('Image pulled', { image });
                        resolve(true);
                    }
                });
            });
        });
    }

    async createAndStartContainer(service: ServiceConfig & { resolvedPort?: number }): Promise<boolean> {
        if (!service.image) return false;

        try {
            const portBindings: Record<string, Array<{ HostPort: string }>> = {};
            const exposedPorts: Record<string, object> = {};
            const hostPort = service.resolvedPort ?? service.port;
            const containerPort = `${service.port}/tcp`;
            portBindings[containerPort] = [{ HostPort: String(hostPort) }];
            exposedPorts[containerPort] = {};

            const container = await this.docker.createContainer({
                Image: service.image,
                name: service.name,
                ExposedPorts: exposedPorts,
                Env: Object.entries(service.environment).map(([k, v]) => `${k}=${v}`),
                HostConfig: {
                    PortBindings: portBindings,
                    Binds: service.volumes ?? [],
                    RestartPolicy: { Name: 'unless-stopped' },
                },
            });

            await container.start();
            logger.info('Container created and started', { name: service.name, port: hostPort });
            return true;
        } catch (err) {
            logger.error('Failed to create container', { name: service.name, error: String(err) });
            return false;
        }
    }

    generateDockerCompose(env: EnvironmentConfig): string {
        const services: Record<string, unknown> = {};

        for (const service of env.services) {
            const svcDef: Record<string, unknown> = {
                ports: [`${service.resolvedPort ?? service.port}:${service.port}`],
                environment: Object.entries(service.environment).map(([k, v]) => `${k}=${v}`),
            };

            if (service.image) svcDef['image'] = service.image;
            if (service.command) svcDef['command'] = service.command;
            if (service.volumes?.length) svcDef['volumes'] = service.volumes;
            if (service.dependsOn?.length) svcDef['depends_on'] = service.dependsOn;
            if (service.healthCheck) {
                svcDef['healthcheck'] = { test: service.healthCheck, interval: '30s', timeout: '10s', retries: 3 };
            }

            services[service.name] = svcDef;
        }

        return yaml.stringify({ version: '3.8', services });
    }

    private mapStatus(state: string): ContainerStatus['status'] {
        switch (state.toLowerCase()) {
            case 'running': return 'running';
            case 'exited': return 'exited';
            case 'created': return 'created';
            case 'stopped': return 'stopped';
            default: return 'unknown';
        }
    }
}