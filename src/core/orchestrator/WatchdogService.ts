import { logger } from '../../utils/logger.js';

export type ExecutionState = 'IDLE' | 'EXECUTING' | 'WAITING' | 'STALLED' | 'RECOVERING';

/**
 * WatchdogService — Singleton for monitoring agent health and detecting deadlocks.
 */
export class WatchdogService {
    private static instance: WatchdogService;
    private state: Map<string, {
        lastPulse: number;
        status: ExecutionState;
        taskId: string;
    }> = new Map();

    private checkInterval: NodeJS.Timeout | null = null;
    private readonly STALL_THRESHOLD = 60_000; // 60 seconds without a pulse = Deadlock

    private constructor() {
        this.startMonitoring();
    }

    static getInstance(): WatchdogService {
        if (!WatchdogService.instance) {
            WatchdogService.instance = new WatchdogService();
        }
        return WatchdogService.instance;
    }

    /**
     * Registers a task for monitoring.
     */
    register(taskId: string): void {
        this.state.set(taskId, {
            taskId,
            lastPulse: Date.now(),
            status: 'IDLE'
        });
        logger.debug(`[Watchdog] Registered task ${taskId}`);
    }

    /**
     * Reports signs of life from a task.
     */
    pulse(taskId: string, status: ExecutionState = 'EXECUTING'): void {
        const t = this.state.get(taskId);
        if (t) {
            t.lastPulse = Date.now();
            t.status = status;
        }
    }

    /**
     * Unregisters a task (e.g. on task finish).
     */
    unregister(taskId: string): void {
        this.state.delete(taskId);
        logger.debug(`[Watchdog] Unregistered task ${taskId}`);
    }

    private startMonitoring(): void {
        if (this.checkInterval) return;
        
        this.checkInterval = setInterval(() => {
            const now = Date.now();
            for (const [taskId, entry] of this.state.entries()) {
                const idleTime = now - entry.lastPulse;
                
                if (idleTime > this.STALL_THRESHOLD && entry.status !== 'IDLE' && entry.status !== 'STALLED') {
                    logger.error(`[Watchdog] DEADLOCK DETECTED for task ${taskId}. No progress for ${Math.round(idleTime/1000)}s.`);
                    entry.status = 'STALLED';
                    // In a production environment, we would trigger an event or a force-restart here.
                }
            }
        }, 10000);
        
        this.checkInterval.unref(); // Don't prevent process exit
    }

    getStatus(taskId: string): ExecutionState | 'NOT_FOUND' {
        return this.state.get(taskId)?.status || 'NOT_FOUND';
    }
}
