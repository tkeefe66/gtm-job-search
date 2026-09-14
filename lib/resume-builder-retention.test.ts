import {expect,test,vi,beforeEach} from 'vitest';
const raw=vi.hoisted(()=>vi.fn());
vi.mock('./supabase',()=>({rawQuery:raw}));
import {liveDeps} from './saved-resume-purge';
beforeEach(()=>raw.mockReset());
// Mutation: purge only old saved_resumes, retaining expired builder PDFs forever.
test('purge includes new builder snapshots with explicit tenant scope',async()=>{
 raw.mockResolvedValue({data:[{id:'one'}],error:null});
 const result=await liveDeps(async()=>({tenantIds:['tenant']}),false).purgeTenant('tenant');
 expect(result.deleted).toBe(1);
 expect(raw.mock.calls[0][0]).toContain('delete from resume_builder_versions');
 expect(raw.mock.calls[0][0]).toContain('expires_at <= now()');
 expect(raw.mock.calls[0].slice(1)).toEqual([['tenant'],'tenant']);
});
// Mutation: count only legacy expiry or silently treat DB failure as zero.
test('dry-run counts both formats and fails explicitly on database errors',async()=>{
 raw.mockResolvedValueOnce({data:[{n:'3'}],error:null}).mockResolvedValueOnce({data:[],error:{message:''}});
 const deps=liveDeps(async()=>({tenantIds:['tenant']}),true);
 expect(await deps.countTenant!('tenant')).toBe(3);
 expect(raw.mock.calls[0][0]).toContain('resume_builder_versions');
 await expect(deps.countTenant!('tenant')).rejects.toThrow();
});
