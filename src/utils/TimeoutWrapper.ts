import { logger } from './logger.js';

/**
 * TimeoutError — Special error class for execution hangs.
 */
export class TimeoutError extends Error {
    constructor(message: string, public readonly timeoutMs: number) {
        super(message);
        this.name = 'TimeoutError';
    }
}

/**
 * TimeoutWrapper — Wraps any Promise with a hard timeout and AbortController.
 */
export async function withTimeout<T>(
    promise: (signal?: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label = 'Operation'
): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const result = await promise(controller.signal);
        clearTimeout(timeoutId);
        return result;
    } catch (err: any) {
        clearTimeout(timeoutId);
        
        if (err.name === 'AbortError' || controller.signal.aborted) {
            logger.error(`[Timeout] ${label} exceeded ${timeoutMs}ms limit. Forcefully aborted.`);
            throw new TimeoutError(`${label} timed out after ${timeoutMs}ms`, timeoutMs);
        }
        
        throw err;
    }
}
