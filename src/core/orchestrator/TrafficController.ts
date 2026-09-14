import { EventEmitter } from 'events';
import crypto from 'crypto';
import type { AIProviderKind, ModelRequest, ModelResponse } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { ProviderError, classifyProviderError } from '../ai/providers/ProviderError.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';

const C = { interval:150, concurrency:4, payload:120000, rounds:3, backoff:750, cap:15000, inFlight:160000, deadline:180000 };
type RequestDetails = ModelRequest & { timeoutMs?: number; signal?: AbortSignal };

export interface AIRequest {
    id:string; requestDetails:RequestDetails; providerSequence:AIProviderKind[]; providerIndex:number; round:number;
    estimatedTokens:number; enqueuedAt:number; deadlineAt:number; fatalProviders:Set<AIProviderKind>; lastError?:string;
    resolve:(value:ModelResponse)=>void; reject:(reason:Error)=>void;
}

export class TokenEstimator {
    static estimate(text:string):number { return text ? Math.ceil(text.length / 3.5) : 0; }
}

export class RetryHandler {
    static calculateDelay(round:number, retryAfterMs?:number):number {
        if (Number.isFinite(retryAfterMs) && retryAfterMs! >= 0) return Math.floor(retryAfterMs!);
        const cap = Math.min(C.cap, C.backoff * 2 ** round);
        return Math.floor(cap / 2 + Math.random() * cap / 2);
    }
}

export class AdaptiveConcurrencyManager {
    public limit = 1;
    recordSuccess():void { if (this.limit < C.concurrency) this.limit++; }
    recordOverload():void { this.limit = Math.max(1, Math.floor(this.limit / 2)); }
}

export class TrafficController extends EventEmitter {
    private static instance:TrafficController;
    private queue:AIRequest[] = [];
    private inFlightRequests = new Map<string,AIRequest>();
    private inFlightTokens = 0;
    private concurrencyManager = new AdaptiveConcurrencyManager();
    private lastDispatchTime = 0;
    private processing = false;
    private networkExecutor?: (req:AIRequest, provider:AIProviderKind)=>Promise<ModelResponse>;

    constructor(private healthTracker:ProviderHealthTracker = ProviderHealthTracker.getInstance()) { super(); }
    static getInstance():TrafficController { return this.instance ??= new TrafficController(); }
    static createIsolated():TrafficController { return new TrafficController(ProviderHealthTracker.createIsolated()); }
    setNetworkExecutor(executor:(req:AIRequest, provider:AIProviderKind)=>Promise<ModelResponse>):void { this.networkExecutor = executor; }

    async schedule(requestDetails:ModelRequest, providerSequence:AIProviderKind[]):Promise<ModelResponse> {
        const providers = [...new Set(providerSequence)];
        if (!providers.length) throw new Error('NO_PROVIDER_AVAILABLE: no configured/healthy provider candidates were supplied.');
        if (!this.networkExecutor) throw new Error('ORCHESTRATOR_NOT_READY: network executor is not configured.');
        const details = requestDetails as RequestDetails;
        if (details.signal?.aborted) throw new Error('PROVIDER_CANCELLED: request was cancelled.');
        const estimatedTokens = TokenEstimator.estimate(this.contextText(details.context));
        if (estimatedTokens > C.payload) throw new Error(`PAYLOAD_TOO_LARGE: estimated ${estimatedTokens} tokens exceeds scheduler limit ${C.payload}.`);
        const now = Date.now();
        const timeout = Number.isFinite(details.timeoutMs) && details.timeoutMs! > 0 ? Math.floor(details.timeoutMs!) : C.deadline;
        return new Promise<ModelResponse>((resolve,reject)=>{
            this.queue.push({ id:crypto.randomUUID(), requestDetails:details, providerSequence:providers, providerIndex:0, round:0,
                estimatedTokens, enqueuedAt:now, deadlineAt:now+timeout, fatalProviders:new Set(), resolve, reject });
            void this.startProcessor();
        });
    }

    private async startProcessor():Promise<void> {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length || this.inFlightRequests.size) {
                this.rejectExpired(); this.tryDispatch();
                await new Promise(resolve=>setTimeout(resolve,40));
            }
        } finally { this.processing=false; if (this.queue.length) void this.startProcessor(); }
    }

    private tryDispatch():void {
        if (!this.queue.length || !this.networkExecutor || this.inFlightRequests.size >= this.concurrencyManager.limit) return;
        const req = this.queue[0]!;
        if (req.requestDetails.signal?.aborted) { this.queue.shift(); req.reject(new Error('PROVIDER_CANCELLED: request was cancelled.')); return; }
        if (Date.now() >= req.deadlineAt) { this.queue.shift(); req.reject(this.deadlineError(req)); return; }
        if (this.inFlightRequests.size && this.inFlightTokens + req.estimatedTokens > C.inFlight) return;
        if (Date.now() - this.lastDispatchTime < C.interval) return;
        const selected = this.selectProvider(req); if (!selected) return;
        this.queue.shift(); req.providerIndex=selected.index; this.lastDispatchTime=Date.now();
        this.inFlightRequests.set(req.id,req); this.inFlightTokens += req.estimatedTokens;
        void this.executeNetworkCall(req,selected.provider);
    }

    private selectProvider(req:AIRequest):{provider:AIProviderKind;index:number}|null {
        const model=req.requestDetails.modelOverride;
        for (let offset=0; offset<req.providerSequence.length; offset++) {
            const index=(req.providerIndex+offset)%req.providerSequence.length, provider=req.providerSequence[index]!;
            if (!req.fatalProviders.has(provider) && this.healthTracker.isHealthy(provider,model)) return {provider,index};
        }
        return null;
    }

    private async executeNetworkCall(req:AIRequest,provider:AIProviderKind):Promise<void> {
        const remaining=req.deadlineAt-Date.now();
        if (remaining<=0) { this.finalize(req); req.reject(this.deadlineError(req)); return; }
        const controller=new AbortController(), source=req.requestDetails.signal;
        let sourceAbort:(()=>void)|undefined;
        if (source) {
            if (source.aborted) controller.abort(source.reason);
            else { sourceAbort=()=>controller.abort(source.reason); source.addEventListener('abort',sourceAbort,{once:true}); }
        }
        let expired=false, timer:ReturnType<typeof setTimeout>|undefined;
        const timeout=new Promise<never>((_,reject)=>{ timer=setTimeout(()=>{ expired=true; controller.abort(); reject(this.deadlineError(req)); },remaining); });
        const dispatched:AIRequest={...req,requestDetails:{...req.requestDetails,signal:controller.signal}};
        try {
            const response=await Promise.race([this.networkExecutor!(dispatched,provider),timeout]);
            this.healthTracker.reportSuccess(provider,req.requestDetails.modelOverride ?? response.model);
            this.concurrencyManager.recordSuccess(); this.finalize(req); req.resolve(response);
        } catch (error) {
            if (expired || Date.now()>=req.deadlineAt) { this.finalize(req); req.reject(this.deadlineError(req)); }
            else if (source?.aborted) { this.finalize(req); req.reject(new Error('PROVIDER_CANCELLED: request was cancelled.')); }
            else this.handleFailure(req,provider,error);
        } finally { if (timer) clearTimeout(timer); if (source && sourceAbort) source.removeEventListener('abort',sourceAbort); }
    }

    private handleFailure(req:AIRequest,provider:AIProviderKind,error:unknown):void {
        this.finalize(req);
        const failure=error instanceof ProviderError ? error : classifyProviderError(error,provider);
        this.healthTracker.reportFailure(provider,failure,req.requestDetails.modelOverride);
        req.lastError=`${failure.code}: ${failure.message}`;
        if (failure.code==='RATE_LIMIT') this.concurrencyManager.recordOverload();
        if (failure.isFatal) req.fatalProviders.add(provider);
        req.providerIndex++;
        if (req.providerIndex>=req.providerSequence.length) { req.providerIndex=0; req.round++; }
        if (req.fatalProviders.size>=req.providerSequence.length || req.round>=C.rounds) { req.reject(this.exhaustedError(req)); return; }
        if (Date.now()>=req.deadlineAt) { req.reject(this.deadlineError(req)); return; }
        const remaining=Math.max(0,req.deadlineAt-Date.now());
        const delay=Math.min(failure.isFatal?0:RetryHandler.calculateDelay(req.round,failure.retryAfterMs),remaining);
        logger.warn('Provider request failed; scheduling next candidate',{provider,code:failure.code,round:req.round,delay});
        setTimeout(()=>{ if (Date.now()>=req.deadlineAt) req.reject(this.deadlineError(req)); else { this.queue.unshift(req); void this.startProcessor(); } },delay);
    }

    private rejectExpired():void {
        const now=Date.now(), retained:AIRequest[]=[];
        for (const req of this.queue) {
            if (req.requestDetails.signal?.aborted) req.reject(new Error('PROVIDER_CANCELLED: request was cancelled.'));
            else if (now>=req.deadlineAt) req.reject(this.deadlineError(req)); else retained.push(req);
        }
        this.queue=retained;
    }
    private deadlineError(req:AIRequest):Error { return new Error(`PROVIDER_TIMEOUT: request exceeded ${req.deadlineAt-req.enqueuedAt}ms without a usable provider.${req.lastError?` Last error: ${req.lastError}`:''}`); }
    private exhaustedError(req:AIRequest):Error { return new Error(`PROVIDER_EXHAUSTED: ${req.providerSequence.join(', ')} exhausted.${req.lastError?` Last error: ${req.lastError}`:''}`); }
    private finalize(req:AIRequest):void { if (this.inFlightRequests.delete(req.id)) this.inFlightTokens=Math.max(0,this.inFlightTokens-req.estimatedTokens); }
    private contextText(context:unknown):string {
        if (typeof context==='string') return context;
        if (Array.isArray(context)) return context.map(item=>item && typeof item==='object' && 'content' in item ? String((item as any).content??'') : String(item??'')).join('\n');
        return String(context??'');
    }
    getInternalMetrics():{queueDepth:number;inFlightCount:number;inFlightTokens:number;concurrencyLimit:number} {
        return {queueDepth:this.queue.length,inFlightCount:this.inFlightRequests.size,inFlightTokens:this.inFlightTokens,concurrencyLimit:this.concurrencyManager.limit};
    }
}
