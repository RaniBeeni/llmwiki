import type { WikiPage } from './wiki.js';
import { ESG_ACCESS_CLASSES, ESG_PAGE_TYPES, ESG_REVIEW_STATES } from './esg-policy.js';

export interface EsgLintFinding { severity: 'error'|'warning'|'info'; category: string; message: string; }
export function lintEsgPage(page: WikiPage, validRequirementIds?: ReadonlySet<string>): EsgLintFinding[] {
  const fm = page.frontmatter as Record<string, any>; const body = page.body; const out: EsgLintFinding[] = [];
  const add = (severity:EsgLintFinding['severity'], category:string, message:string) => out.push({severity,category,message});
  if (fm.status !== 'shadow') add('error','official-shadow-status-conflict','status must be shadow');
  if (!ESG_PAGE_TYPES.has(fm.type)) add('error','frontmatter-validation',`invalid type ${fm.type}`);
  if (!ESG_REVIEW_STATES.has(fm.review_state)) add('error','frontmatter-validation',`invalid review_state ${fm.review_state}`);
  if (!fm.authority_scope) add('warning','missing-authority','authority_scope is missing');
  if (fm.access_classification && !ESG_ACCESS_CLASSES.has(fm.access_classification)) add('error','forbidden-company-data',`access_classification ${fm.access_classification} is not allowed in P0`);
  if (fm.authority_scope === 'company-confidential') add('error','forbidden-company-data','company-confidential content is prohibited in P0');
  if (['standard','source','requirement-ref','canonical-item','crosswalk','concept','methodology'].includes(fm.type) && (!Array.isArray(fm.source_refs) || fm.source_refs.length === 0)) add('warning','missing-source-ref','source_refs is empty');
  if ((fm.source_refs?.length ?? 0) > 0 && !fm.source_locator && !/\b(page|paragraph|para|question|문단|페이지|locator)\b/i.test(body)) add('warning','missing-locator','source reference exists but no locator is visible');
  if (/\b(direct equivalent|직접대응|동일 요구|equivalent)\b/i.test(body) && !/\b(proposed|TBD|approved mapping|확정)\b/i.test(body)) add('warning','silent-equivalence','equivalence language lacks proposed/TBD/confirmed qualifier');
  if (validRequirementIds && Array.isArray(fm.requirement_ids)) for (const id of fm.requirement_ids) if (!validRequirementIds.has(id)) add('error','invalid-requirement-id',`unknown Requirement ID ${id}`);
  return out;
}
