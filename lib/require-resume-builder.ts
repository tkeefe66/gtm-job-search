import { requireActor } from './require-actor';
import { readOnboardedAtFor } from './settings-store';
export function resumeBuilderEnabled(isAdmin: boolean, enabled = process.env.RESUME_BUILDER_ENABLED): boolean { return isAdmin || enabled === 'true'; }
export async function requireResumeBuilder() {
    const actor = await requireActor();
    if (actor.userId === 'platform' || !resumeBuilderEnabled(actor.isAdmin))
        throw new Error('Resume builder is not enabled for this account.');
    if (!actor.isAdmin && !await readOnboardedAtFor(actor.tenantId))
        throw new Error('Complete onboarding before creating resumes.');
    return actor;
}
