import { withTimeout, TimeoutError } from '../../utils/TimeoutWrapper.js';
import { WatchdogService } from './WatchdogService.js';
import { logger } from '../../utils/logger.js';

export interface ExecutorOptions {
    timeoutMs: number;
    label: string;
    taskId?: string;
    critical?: boolean;
}

/**
 * SafeExecutor — High-level protective layer for sensitive AI and Tool calls.
 */
export class SafeExecutor {
    private static watchdog = WatchdogService.getInstance();

    /**
     * Executes a task with timeout protection and watchdog pulses.
     */
    static async run<T>(
        task: (signal?: AbortSignal) => Promise<T>,
        options: ExecutorOptions
    ): Promise<T> {
        const { timeoutMs, label, taskId } = options;
        
        if (taskId) {
            this.watchdog.pulse(taskId, 'EXECUTING');
        }

        try {
            const result = await withTimeout(task, timeoutMs, label);
            
            if (taskId) {
                this.watchdog.pulse(taskId, 'IDLE');
            }
            
            return result;
        } catch (err: any) {
            if (err instanceof TimeoutError) {
                logger.error(`[SafeExecutor] ${label} HANG DETECTED. Forcing termination.`);
                if (taskId) {
                    this.watchdog.pulse(taskId, 'STALLED');
                }
            }
            throw err;
        }
    }
}
