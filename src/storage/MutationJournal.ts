import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Database } from './Database.js';
import { resolveWithinRoot } from '../core/security/PathPolicy.js';

export type MutationJournalState = 'PREPARED' | 'APPLIED' | 'COMMITTED' | 'ROLLED_BACK' | 'DIVERGED';
export type MutationJournalOperation = 'create' | 'modify' | 'delete' | 'move';

export interface MutationJournalInput {
    sessionId:string; step:number; operation:MutationJournalOperation; sourcePath?:string; destinationPath:string; originalContent:string;
}
export interface MutationJournalRow {
    id:string; sessionId:string; step:number; operation:MutationJournalOperation; sourcePath?:string; destinationPath:string;
    originalContent:string; updatedContent?:string; state:MutationJournalState; createdAt:number; updatedAt:number; error?:string;
}
export interface MutationRecoveryResult { rolledBack:number; diverged:number; }

export class MutationJournal {
    constructor(private db:Database) {}

    begin(input:MutationJournalInput):string {
        const id=crypto.randomUUID(), now=Date.now();
        this.db.prepare(`INSERT INTO mutation_transactions
            (id,session_id,step,operation,source_path,destination_path,original_content,updated_content,state,created_at,updated_at,error)
            VALUES (?,?,?,?,?,?,?,NULL,'PREPARED',?,?,NULL)`
        ).run(id,input.sessionId,input.step,input.operation,input.sourcePath??null,input.destinationPath,input.originalContent,now,now);
        return id;
    }
    markApplied(id:string,updatedContent:string):void { this.transition(id,['PREPARED'],'APPLIED',updatedContent); }
    markCommitted(id:string):void { this.transition(id,['APPLIED'],'COMMITTED'); }
    commit(id:string,persistHistory:()=>void):void { this.db.transaction(()=>{ persistHistory(); this.transition(id,['APPLIED'],'COMMITTED'); }); }
    markRolledBack(id:string,error?:string):void { this.transition(id,['PREPARED','APPLIED'],'ROLLED_BACK',undefined,error); }
    markDiverged(id:string,error:string):void { this.transition(id,['PREPARED','APPLIED'],'DIVERGED',undefined,error); }

    getById(id:string):MutationJournalRow {
        const row=this.db.prepare('SELECT * FROM mutation_transactions WHERE id = ?').get(id);
        if (!row) throw new Error(`Mutation journal entry not found: ${id}`);
        return this.mapRow(row);
    }
    getBySession(sessionId:string):MutationJournalRow[] {
        return this.db.prepare('SELECT * FROM mutation_transactions WHERE session_id = ? ORDER BY created_at, step, id')
            .all(sessionId).map((row:any)=>this.mapRow(row));
    }

    recoverIncomplete(rootDir:string):MutationRecoveryResult {
        const rows=this.db.prepare("SELECT * FROM mutation_transactions WHERE state IN ('PREPARED','APPLIED') ORDER BY created_at,id")
            .all().map((row:any)=>this.mapRow(row));
        const result={rolledBack:0,diverged:0};
        for (const row of rows) {
            try {
                if (this.recoverRow(rootDir,row)) {
                    this.markRolledBack(row.id,'Recovered incomplete mutation after restart.'); result.rolledBack++;
                } else {
                    this.markDiverged(row.id,'Filesystem no longer matches the recorded mutation state.'); result.diverged++;
                }
            } catch (error:any) {
                this.markDiverged(row.id,String(error?.message??error)); result.diverged++;
            }
        }
        return result;
    }

    private recoverRow(rootDir:string,row:MutationJournalRow):boolean {
        const destination=this.resolveInside(rootDir,row.destinationPath);
        const source=row.sourcePath?this.resolveInside(rootDir,row.sourcePath):undefined;
        if (row.state==='PREPARED') {
            if (row.operation==='create') return !fs.existsSync(destination);
            if (row.operation==='move') return Boolean(source && this.readIfFile(source)===row.originalContent && !fs.existsSync(destination));
            return this.readIfFile(destination)===row.originalContent;
        }

        const updated=row.updatedContent??'';
        if (row.operation==='create') {
            if (!fs.existsSync(destination)) return true;
            if (this.readIfFile(destination)!==updated) return false;
            this.removeDurably(destination); return true;
        }
        if (row.operation==='modify') {
            const current=this.readIfFile(destination);
            if (current===row.originalContent) return true;
            if (current!==updated) return false;
            this.atomicWrite(rootDir,destination,row.originalContent); return true;
        }
        if (row.operation==='delete') {
            if (fs.existsSync(destination)) return this.readIfFile(destination)===row.originalContent;
            this.atomicWrite(rootDir,destination,row.originalContent); return true;
        }
        if (!source) return false;
        const sourceCurrent=this.readIfFile(source), destinationCurrent=this.readIfFile(destination);
        if (sourceCurrent===row.originalContent && !fs.existsSync(destination)) return true;
        if (sourceCurrent!==undefined || destinationCurrent!==updated) return false;
        this.resolveInside(rootDir,source); this.resolveInside(rootDir,destination);
        fs.mkdirSync(path.dirname(source),{recursive:true});
        this.resolveInside(rootDir,path.dirname(source));
        fs.renameSync(destination,source);
        this.syncDirectory(path.dirname(source));
        if (path.dirname(destination)!==path.dirname(source)) this.syncDirectory(path.dirname(destination));
        return true;
    }

    private transition(id:string,allowed:MutationJournalState[],state:MutationJournalState,updatedContent?:string,error?:string):void {
        const placeholders=allowed.map(()=>'?').join(',');
        const result=this.db.prepare(`UPDATE mutation_transactions SET state=?,updated_content=COALESCE(?,updated_content),updated_at=?,error=?
            WHERE id=? AND state IN (${placeholders})`).run(state,updatedContent??null,Date.now(),error??null,id,...allowed);
        if (result.changes!==1) {
            const current=this.db.prepare('SELECT state FROM mutation_transactions WHERE id = ?').get(id) as {state?:string}|undefined;
            throw new Error(`Invalid mutation journal transition for ${id}: ${current?.state??'missing'} -> ${state}`);
        }
    }

    private mapRow(row:any):MutationJournalRow {
        return { id:String(row.id),sessionId:String(row.session_id),step:Number(row.step),operation:row.operation as MutationJournalOperation,
            sourcePath:row.source_path==null?undefined:String(row.source_path),destinationPath:String(row.destination_path),
            originalContent:String(row.original_content),updatedContent:row.updated_content==null?undefined:String(row.updated_content),
            state:row.state as MutationJournalState,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),
            error:row.error==null?undefined:String(row.error) };
    }

    private resolveInside(rootDir:string,storedPath:string):string { return resolveWithinRoot(storedPath,rootDir,storedPath); }
    private readIfFile(target:string):string|undefined {
        try { if (!fs.statSync(target).isFile()) return undefined; return fs.readFileSync(target,'utf8'); }
        catch(error:any) { if (error?.code==='ENOENT') return undefined; throw error; }
    }
    private atomicWrite(rootDir:string,target:string,content:string):void {
        const safeTarget=this.resolveInside(rootDir,target), directory=path.dirname(safeTarget);
        fs.mkdirSync(directory,{recursive:true}); this.resolveInside(rootDir,directory);
        const temp=this.resolveInside(rootDir,`${safeTarget}.cos-recovery-${crypto.randomUUID()}`);
        let fd:number|undefined;
        try {
            fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
            fs.writeFileSync(fd,content,'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
            this.resolveInside(rootDir,safeTarget); this.resolveInside(rootDir,directory);
            fs.renameSync(temp,safeTarget); this.syncDirectory(directory);
        } catch (error) {
            if (fd!==undefined) try { fs.closeSync(fd); } catch {}
            try { fs.rmSync(temp,{force:true}); } catch {}
            throw error;
        }
    }
    private removeDurably(target:string):void { fs.rmSync(target,{force:true}); this.syncDirectory(path.dirname(target)); }
    private syncDirectory(directory:string):void {
        let fd:number|undefined;
        try { fd=fs.openSync(directory,fs.constants.O_RDONLY); fs.fsyncSync(fd); }
        catch(error:any) {
            const unsupported=process.platform==='win32' && ['EPERM','EACCES','EINVAL','EBADF','EISDIR'].includes(String(error?.code));
            if (!unsupported) throw error;
        } finally { if (fd!==undefined) try { fs.closeSync(fd); } catch {} }
    }
}
