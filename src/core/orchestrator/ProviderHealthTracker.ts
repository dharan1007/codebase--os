import { logger } from '../../utils/logger.js';
import type { AIProviderKind } from '../../types/index.js';
import { ProviderError, classifyProviderError } from '../ai/providers/ProviderError.js';

export type ProviderStatus='HEALTHY'|'DEGRADED'|'CIRCUIT_BROKEN';
type Stats={status:ProviderStatus;consecutiveFailures:number;lastErrorAt?:number;cooldownUntil?:number;successCount:number;errorCount:number};

export class ProviderHealthTracker {
    private static instance:ProviderHealthTracker;
    private stats=new Map<string,Stats>();
    private constructor() {}
    static getInstance():ProviderHealthTracker { return this.instance ??= new ProviderHealthTracker(); }
    static createIsolated():ProviderHealthTracker { return new ProviderHealthTracker(); }

    reportSuccess(provider:AIProviderKind,model?:string):void {
        const s=this.get(provider,model); s.successCount++; s.consecutiveFailures=0; s.status='HEALTHY'; s.cooldownUntil=undefined;
    }

    reportFailure(provider:AIProviderKind,error:unknown,model?:string):void {
        const s=this.get(provider,model), e=error instanceof ProviderError?error:classifyProviderError(error,provider);
        s.errorCount++; s.consecutiveFailures++; s.lastErrorAt=Date.now();
        if (e.code==='RATE_LIMIT') {
            const fallback=15_000*3**Math.min(s.consecutiveFailures-1,2), delay=Math.max(0,e.retryAfterMs??fallback);
            s.cooldownUntil=Date.now()+delay; s.status=s.consecutiveFailures>=3?'CIRCUIT_BROKEN':'DEGRADED';
            logger.warn('Provider rate limited',{provider,model,delay,status:s.status}); return;
        }
        if (e.isFatal) {
            s.status='CIRCUIT_BROKEN'; s.cooldownUntil=Date.now()+60_000;
            logger.warn('Provider/model temporarily unavailable after fatal failure',{provider,model,code:e.code}); return;
        }
        if (s.consecutiveFailures>=2) { s.status='DEGRADED'; s.cooldownUntil=Date.now()+30_000; }
    }

    isHealthy(provider:AIProviderKind,model?:string):boolean {
        const s=this.stats.get(this.key(provider,model)); if (!s) return true; this.refresh(s);
        return !(s.cooldownUntil && Date.now()<s.cooldownUntil) && s.status!=='CIRCUIT_BROKEN';
    }

    getWeight(provider:AIProviderKind,model?:string):number {
        const s=this.stats.get(this.key(provider,model)); if (!s) return 1; if (!this.isHealthy(provider,model)) return 0;
        const total=s.successCount+s.errorCount, rate=total?s.successCount/total:1; return Math.max(.1,rate-s.consecutiveFailures*.2);
    }

    getSummary():Array<{provider:AIProviderKind;model?:string;status:ProviderStatus;successRate:string;cooldownRemaining:number}> {
        return [...this.stats.entries()].map(([key,s])=>{ this.refresh(s); const [provider,model]=key.split('\u0000'); return {
            provider:provider as AIProviderKind, model:model||undefined, status:s.status,
            successRate:(s.successCount/(s.successCount+s.errorCount||1)).toFixed(2),
            cooldownRemaining:s.cooldownUntil?Math.max(0,s.cooldownUntil-Date.now()):0
        };});
    }

    private key(provider:AIProviderKind,model?:string):string { return `${provider}\u0000${model??''}`; }
    private refresh(s:Stats):void { if (s.cooldownUntil && Date.now()>=s.cooldownUntil) { s.cooldownUntil=undefined; if (s.status==='CIRCUIT_BROKEN') s.status='DEGRADED'; } }
    private get(provider:AIProviderKind,model?:string):Stats {
        const key=this.key(provider,model); let s=this.stats.get(key);
        if (!s) { s={status:'HEALTHY',consecutiveFailures:0,successCount:0,errorCount:0}; this.stats.set(key,s); }
        return s;
    }
}
