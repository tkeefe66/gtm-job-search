import {beforeEach,test,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({actor:vi.fn(),onboarded:vi.fn()}));
vi.mock('./require-actor',()=>({requireActor:h.actor}));
vi.mock('./settings-store',()=>({readOnboardedAtFor:h.onboarded}));
import {requireResumeBuilder,resumeBuilderEnabled} from './require-resume-builder';
beforeEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();h.actor.mockResolvedValue({userId:'u',tenantId:'u',isAdmin:false});});
// Mutation: capability defaults open or admin branch carries content defaults.
test('capability defaults closed for ordinary tenants and open for admin preview',()=>{expect(resumeBuilderEnabled(false,'')).toBe(false);expect(resumeBuilderEnabled(false,'true')).toBe(true);expect(resumeBuilderEnabled(true,'')).toBe(true);});
// Mutation: platform actor passes tenant rollout gate.
test('platform calls fail even when rollout enabled',async()=>{vi.stubEnv('RESUME_BUILDER_ENABLED','true');h.actor.mockResolvedValue({userId:'platform',tenantId:'platform',isAdmin:false});await expect(requireResumeBuilder()).rejects.toThrow(/not enabled/);expect(h.onboarded).not.toHaveBeenCalled();});
// Mutation: status-approved but unonboarded user can start builder actions.
test('enabled tenant must complete onboarding',async()=>{vi.stubEnv('RESUME_BUILDER_ENABLED','true');h.onboarded.mockResolvedValue(null);await expect(requireResumeBuilder()).rejects.toThrow(/onboarding/);h.onboarded.mockResolvedValue('2026-09-14');expect((await requireResumeBuilder()).tenantId).toBe('u');});
