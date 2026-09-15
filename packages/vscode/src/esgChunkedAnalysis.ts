import * as vscode from 'vscode';
import { structureAwareChunks } from '@llmwiki/core';

export interface CompatibleLlmAnalysis {
  summary: string;
  entities: Array<{ name: string; content: string; tags: string[] }>;
  concepts: Array<{ name: string; content: string; tags: string[] }>;
  crosslinks: Array<{ from: string; to: string[] }>;
}

export async function analyzeSourceInChunks(
  sourceContent: string,
  analyzeOne: (content:string, locator:string) => Promise<CompatibleLlmAnalysis | null>,
  token: vscode.CancellationToken,
): Promise<CompatibleLlmAnalysis | null> {
  const chunks=structureAwareChunks(sourceContent);
  const analyses:CompatibleLlmAnalysis[]=[];
  for(const chunk of chunks){
    if(token.isCancellationRequested) break;
    const loc=`${chunk.chunk_id}; page=${chunk.locator.page ?? '?'}; heading=${chunk.locator.heading ?? '?'}`;
    const a=await analyzeOne(chunk.text,loc); if(a) analyses.push(a);
  }
  if(analyses.length===0) return null;
  const byName=<T extends {name:string;content:string;tags:string[]}>(items:T[]):T[]=>{
    const m=new Map<string,T>(); for(const item of items){ const key=item.name.trim().toLowerCase(); const prev=m.get(key); if(!prev)m.set(key,item); else m.set(key,{...prev,content:`${prev.content}\n\n${item.content}`,tags:[...new Set([...prev.tags,...item.tags])]} as T); } return [...m.values()];
  };
  const links=new Map<string,Set<string>>(); for(const a of analyses)for(const l of a.crosslinks){const s=links.get(l.from)??new Set<string>(); l.to.forEach(x=>s.add(x));links.set(l.from,s);}
  return { summary:analyses.map((a,i)=>`### Chunk ${i+1}\n\n${a.summary}`).join('\n\n'), entities:byName(analyses.flatMap(a=>a.entities)), concepts:byName(analyses.flatMap(a=>a.concepts)), crosslinks:[...links].map(([from,to])=>({from,to:[...to]})) };
}
