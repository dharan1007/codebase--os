import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { PortConflict } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export class PortManager {
    private reservedPorts = new Set<number>();

    async isPortInUse(port: number): Promise<boolean> {
        return new Promise(resolve => {
            const server = net.createServer();
            server.once('error', (err: NodeJS.ErrnoException) => {
                resolve(err.code === 'EADDRINUSE');
            });
            server.once('listening', () => {
                server.close();
                resolve(false);
            });
            server.listen(port, '127.0.0.1');
        });
    }

    async getPortOccupant(port: number): Promise<string | null> {
        try {
            const { stdout } = await execAsync(`lsof -i :${port} -n -P 2>/dev/null | tail -n 1`);
            const parts = stdout.trim().split(/\s+/);
            return parts[0] ? `${parts[0]} (PID: ${parts[1] ?? 'unknown'})` : null;
        } catch {
            try {
                const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
                return stdout.trim() ? stdout.trim().slice(0, 60) : null;
            } catch {
                return null;
            }
        }
    }

    async findFreePort(preferredPort: number, rangeEnd?: number): Promise<number> {
        const end = rangeEnd ?? preferredPort + 100;

        for (let port = preferredPort; port <= end; port++) {
            if (this.reservedPorts.has(port)) continue;
            const inUse = await this.isPortInUse(port);
            if (!inUse) {
                this.reservedPorts.add(port);
                return port;
            }
        }

        const fallback = await this.findRandomFreePort(49152, 65535);
        this.reservedPorts.add(fallback);
        return fallback;
    }

    private findRandomFreePort(min: number, max: number): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as net.AddressInfo;
                server.close(() => resolve(addr.port));
            });
            server.once('error', reject);
        });
    }

    async resolveConflicts(ports: Array<{ serviceName: string; port: number }>): Promise<PortConflict[]> {
        const conflicts: PortConflict[] = [];

        for (const { serviceName, port } of ports) {
            const inUse = await this.isPortInUse(port);
            if (!inUse) continue;

            const occupiedBy = await this.getPortOccupant(port);
            const resolvedPort = await this.findFreePort(port + 1);

            conflicts.push({ port, serviceName, occupiedBy: occupiedBy ?? undefined, resolvedPort });
            logger.info(`Port conflict resolved: ${serviceName} ${port} → ${resolvedPort}`, { occupiedBy });
        }

        return conflicts;
    }

    release(port: number): void {
        this.reservedPorts.delete(port);
    }

    releaseAll(): void {
        this.reservedPorts.clear();
    }
}