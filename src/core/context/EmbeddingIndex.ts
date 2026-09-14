import { Database } from '../../storage/Database.js';
import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

export interface CodeChunk { id:string; filePath:string; content:string; embedding?:number[]; startLine?:number; endLine?:number; similarity?:number; }
export interface EmbeddingStats { totalChunks:number; totalFiles:number; vectorChunks:number; }

const SKETCH_DIM=16, OVER_FETCH=12, EXACT_SCAN_THRESHOLD=1000, LSH_TABLES=8, LSH_BITS=10;
const EMPTY_VECTOR=Buffer.alloc(0);

export class EmbeddingIndex {
    constructor(private db:Database,private ai:AIProvider) { this.runMigration(); }

    private runMigration():void {
        try { this.db.prepare('SELECT sketchBlob, dim, updatedAt FROM embeddings_cache LIMIT 1').get(); }
        catch {
            try { this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN sketchBlob BLOB'); } catch {}
            try { this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN dim INTEGER NOT NULL DEFAULT 0'); } catch {}
            try { this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0'); } catch {}
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS embedding_lsh_buckets (
            chunk_id TEXT NOT NULL,
            table_id INTEGER NOT NULL,
            bucket_hash TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(chunk_id, table_id),
            FOREIGN KEY(chunk_id) REFERENCES embeddings_cache(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_embedding_lsh_lookup
            ON embedding_lsh_buckets(table_id, bucket_hash, chunk_id);
        `);
        this.backfillLshIndex();
    }

    async embedAndStore(chunks:CodeChunk[],onProgress?:(count:number)=>void):Promise<void> {
        if (!chunks.length) return;
        const ids=chunks.map(c=>c.id), placeholders=ids.map(()=>'?').join(',');
        const existing=this.db.prepare(`SELECT id, contentHash FROM embeddings_cache WHERE id IN (${placeholders})`).all(...ids) as Array<{id:string;contentHash:string}>;
        const byId=new Map(existing.map(r=>[r.id,r.contentHash]));
        const pending=chunks.filter(c=>byId.get(c.id)!==this.hashContent(c.content));
        let processed=chunks.length-pending.length; onProgress?.(processed); if (!pending.length) return;
        for (let offset=0;offset<pending.length;offset+=50) {
            const batch=pending.slice(offset,offset+50);
            this.persistLexicalBatch(batch);
            if (!this.ai.batchEmbed&&!this.ai.embed) { processed+=batch.length; onProgress?.(processed); continue; }
            try {
                const texts=batch.map(c=>c.content); let vectors:number[][];
                if (this.ai.batchEmbed) vectors=await this.ai.batchEmbed(texts);
                else { vectors=[]; for (const text of texts) vectors.push(await this.ai.embed!(text)); }
                if (vectors.length!==batch.length) throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`);
                this.db.transaction(()=>{
                    const update=this.db.prepare(`UPDATE embeddings_cache SET embeddingBlob=?,sketchBlob=?,dim=?,updatedAt=? WHERE id=? AND contentHash=?`);
                    for (let i=0;i<batch.length;i++) {
                        const chunk=batch[i]!, vector=vectors[i];
                        if (!this.isValidVector(vector)) continue;
                        const sketch=this.computeSketch(vector,SKETCH_DIM);
                        update.run(Buffer.from(new Float32Array(vector).buffer),Buffer.from(new Float32Array(sketch).buffer),vector.length,Date.now(),chunk.id,this.hashContent(chunk.content));
                        this.replaceLshEntries(chunk.id,sketch);
                    }
                });
            } catch(err) { logger.warn('EmbeddingIndex: embedding batch failed; lexical corpus retained',{batchStart:offset,error:String(err)}); }
            processed+=batch.length; onProgress?.(processed);
        }
    }

    async search(query:string,topK=5):Promise<CodeChunk[]> {
        if (topK<=0) return [];
        const queryVector=await this.embedQuery(query); if (!this.isValidVector(queryVector)) return [];
        const row=this.db.prepare('SELECT COUNT(*) AS count FROM embeddings_cache WHERE dim > 0 AND length(embeddingBlob) > 0').get() as {count:number}|undefined;
        const size=Number(row?.count??0); if (!size) return [];
        let candidates:Array<{id:string;filePath:string;content:string;embeddingBlob:Buffer}>;
        if (size<=EXACT_SCAN_THRESHOLD) candidates=this.db.prepare('SELECT id,filePath,content,embeddingBlob FROM embeddings_cache WHERE dim > 0 AND length(embeddingBlob) > 0').all() as typeof candidates;
        else candidates=this.fetchCandidatesByLsh(queryVector,Math.max(topK*OVER_FETCH,topK));
        return candidates.map(r=>({id:r.id,filePath:r.filePath,content:r.content,similarity:this.cosineSimilarity(queryVector,this.decodeVector(r.embeddingBlob))}))
            .filter(c=>Number.isFinite(c.similarity)&&(c.similarity??0)>0).sort((a,b)=>(b.similarity??0)-(a.similarity??0)||a.id.localeCompare(b.id)).slice(0,topK);
    }

    async hybridSearch(query:string,topK=5):Promise<CodeChunk[]> {
        if (topK<=0) return [];
        const [vectorResults,keywordResults]=await Promise.all([this.search(query,topK*2),Promise.resolve(this.keywordSearch(query,topK*2))]);
        const scores=new Map<string,number>(), chunks=new Map<string,CodeChunk>(), damping=60;
        vectorResults.forEach((c,r)=>{scores.set(c.id,(scores.get(c.id)??0)+1/(damping+r+1));chunks.set(c.id,c);});
        keywordResults.forEach((c,r)=>{scores.set(c.id,(scores.get(c.id)??0)+1/(damping+r+1));if(!chunks.has(c.id))chunks.set(c.id,c);});
        return [...scores.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,topK).map(([id])=>chunks.get(id)).filter((c):c is CodeChunk=>Boolean(c));
    }

    invalidateFile(filePath:string):void { this.db.prepare('DELETE FROM embeddings_cache WHERE filePath = ?').run(filePath); }
    getStats():EmbeddingStats {
        const r=this.db.prepare(`SELECT COUNT(*) totalChunks,COUNT(DISTINCT filePath) totalFiles,SUM(CASE WHEN dim>0 AND length(embeddingBlob)>0 THEN 1 ELSE 0 END) vectorChunks FROM embeddings_cache`).get() as any;
        return {totalChunks:Number(r?.totalChunks??0),totalFiles:Number(r?.totalFiles??0),vectorChunks:Number(r?.vectorChunks??0)};
    }

    private persistLexicalBatch(batch:CodeChunk[]):void {
        const st=this.db.prepare(`INSERT OR REPLACE INTO embeddings_cache(id,filePath,contentHash,content,embeddingBlob,sketchBlob,dim,updatedAt) VALUES (?,?,?,?,?,NULL,0,?)`);
        this.db.transaction(()=>{for(const c of batch)st.run(c.id,c.filePath,this.hashContent(c.content),c.content,EMPTY_VECTOR,Date.now());});
    }

    private backfillLshIndex():void {
        const rows=this.db.prepare(`SELECT e.id,e.sketchBlob,e.embeddingBlob FROM embeddings_cache e
          WHERE e.dim>0 AND length(e.embeddingBlob)>0
          AND NOT EXISTS (SELECT 1 FROM embedding_lsh_buckets b WHERE b.chunk_id=e.id)`).all() as Array<{id:string;sketchBlob:Buffer|null;embeddingBlob:Buffer}>;
        if (!rows.length) return;
        this.db.transaction(()=>{for(const r of rows){const stored=r.sketchBlob&&r.sketchBlob.length?this.decodeVector(r.sketchBlob):this.computeSketch(this.decodeVector(r.embeddingBlob),SKETCH_DIM);if(this.isValidVector(stored))this.replaceLshEntries(r.id,stored);}});
    }

    private replaceLshEntries(chunkId:string,sketch:number[]):void {
        this.db.prepare('DELETE FROM embedding_lsh_buckets WHERE chunk_id=?').run(chunkId);
        const insert=this.db.prepare('INSERT INTO embedding_lsh_buckets(chunk_id,table_id,bucket_hash,updated_at) VALUES (?,?,?,?)'), now=Date.now();
        for (let table=0;table<LSH_TABLES;table++) insert.run(chunkId,table,this.lshBucket(sketch,table),now);
    }

    private fetchCandidatesByLsh(queryVector:number[],limit:number):Array<{id:string;filePath:string;content:string;embeddingBlob:Buffer}> {
        const sketch=this.computeSketch(queryVector,SKETCH_DIM), probes:Array<{table:number;hash:string}>=[];
        for(let table=0;table<LSH_TABLES;table++){
            const exact=this.lshBucket(sketch,table); probes.push({table,hash:exact});
            for(let bit=0;bit<LSH_BITS;bit++) probes.push({table,hash:this.flipBit(exact,bit)});
        }
        const where=probes.map(()=>'(table_id=? AND bucket_hash=?)').join(' OR '), params=probes.flatMap(p=>[p.table,p.hash]);
        const matches=this.db.prepare(`SELECT chunk_id id,COUNT(*) matches FROM embedding_lsh_buckets WHERE ${where} GROUP BY chunk_id ORDER BY matches DESC,chunk_id ASC LIMIT ?`).all(...params,limit) as Array<{id:string;matches:number}>;
        if (!matches.length) return [];
        const ids=matches.map(r=>r.id), placeholders=ids.map(()=>'?').join(',');
        const rows=this.db.prepare(`SELECT id,filePath,content,embeddingBlob FROM embeddings_cache WHERE id IN (${placeholders}) AND dim>0 AND length(embeddingBlob)>0`).all(...ids) as Array<{id:string;filePath:string;content:string;embeddingBlob:Buffer}>;
        const order=new Map(ids.map((id,i)=>[id,i])); return rows.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0));
    }

    private lshBucket(sketch:number[],table:number):string {
        let bits='';
        for(let bit=0;bit<LSH_BITS;bit++){
            let score=0; for(let d=0;d<sketch.length;d++) score+=sketch[d]!*this.projectionSign(table,bit,d);
            bits+=score>=0?'1':'0';
        }
        return bits;
    }
    private projectionSign(table:number,bit:number,dim:number):number {
        let x=(Math.imul(table+1,73856093)^Math.imul(bit+1,19349663)^Math.imul(dim+1,83492791))>>>0;
        x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)&1?1:-1;
    }
    private flipBit(hash:string,index:number):string { return hash.slice(0,index)+(hash[index]==='1'?'0':'1')+hash.slice(index+1); }

    private async embedQuery(query:string):Promise<number[]|null> {
        try { if(this.ai.batchEmbed){const v=await this.ai.batchEmbed([query]);return v[0]?.length?v[0]:null;} if(this.ai.embed){const v=await this.ai.embed(query);return v?.length?v:null;} return null; }
        catch(err){logger.debug('EmbeddingIndex: query embedding unavailable',{error:String(err)});return null;}
    }
    private keywordSearch(query:string,topK:number):CodeChunk[] {
        const terms=[...new Set(query.toLowerCase().split(/[^a-z0-9_$.-]+/).map(t=>t.trim()).filter(t=>t.length>2))].slice(0,8); if(!terms.length)return[];
        const clauses=terms.map(()=>'LOWER(content) LIKE ?'),params=terms.map(t=>`%${t}%`),score=terms.map(()=>'CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END').join(' + ');
        try { const rows=this.db.prepare(`SELECT id,filePath,content,(${score}) lexicalScore FROM embeddings_cache WHERE ${clauses.join(' OR ')} ORDER BY lexicalScore DESC,id ASC LIMIT ?`).all(...params,...params,topK) as any[]; return rows.map(r=>({id:r.id,filePath:r.filePath,content:r.content,similarity:r.lexicalScore/terms.length})); }
        catch(err){logger.debug('EmbeddingIndex: keyword search failed',{error:String(err)});return[];}
    }
    private isValidVector(v:number[]|null|undefined):v is number[]{return Boolean(v&&v.length&&v.every(Number.isFinite)&&v.some(x=>x!==0));}
    private computeSketch(v:number[],dims:number):number[]{if(v.length<=dims)return v.slice();const s:number[]=[];for(let b=0;b<dims;b++){const start=Math.floor(b*v.length/dims),end=Math.max(start+1,Math.floor((b+1)*v.length/dims));let sum=0;for(let i=start;i<Math.min(end,v.length);i++)sum+=v[i]!;s.push(sum/Math.max(1,Math.min(end,v.length)-start));}return s;}
    private decodeVector(blob:Buffer):number[]{if(!blob||!blob.byteLength||blob.byteLength%4)return[];return Array.from(new Float32Array(blob.buffer,blob.byteOffset,blob.byteLength/4));}
    private cosineSimilarity(a:number[],b:number[]):number{if(a.length!==b.length||!a.length)return 0;let dot=0,ma=0,mb=0;for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;ma+=a[i]!*a[i]!;mb+=b[i]!*b[i]!;}return !ma||!mb?0:dot/(Math.sqrt(ma)*Math.sqrt(mb));}
    private hashContent(content:string):string{return crypto.createHash('sha256').update(content).digest('hex');}
}
