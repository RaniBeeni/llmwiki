export interface EsgQueryCandidate { path:string; title:string; body:string; id?:string; requirement_ids?:string[]; source_refs?:string[]; tags?:string[]; domain?:string; }
export interface EsgQueryResult extends EsgQueryCandidate { score:number; }
function count(hay:string, needle:string):number { if(!needle)return 0; return (hay.toLowerCase().match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').toLowerCase(),'g'))||[]).length; }
export function rankEsgCandidates(query:string, candidates:EsgQueryCandidate[], limit=8):EsgQueryResult[] {
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean); const q=query.toLowerCase(); const out:EsgQueryResult[]=[];
  for(const c of candidates){ let score=0; const ids=[c.id,...(c.requirement_ids??[]),...(c.source_refs??[])].filter(Boolean) as string[];
    if(ids.some(x=>x.toLowerCase()===q)) score+=1000;
    for(const t of terms){ score+=count(c.title,t)*20; score+=count(c.domain??'',t)*10; score+=count(JSON.stringify(c.tags??[]),t)*8; score+=count(ids.join(' '),t)*25; score+=count(c.body,t); }
    if(score>0) out.push({...c,score});
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,limit);
}
