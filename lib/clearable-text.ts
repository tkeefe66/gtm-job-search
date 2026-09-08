// Which set_text targets may be emptied.
//
// sanitizeBulletText refuses empty and whitespace-only text ("That text is
// empty."), which is right for a BULLET — removing one is drop_bullet's job,
// and an emptied bullet renders as a stray dash. But it also blocked "remove
// the text under my name", because the tagline is a set_text target and the
// only way to remove a line is to set it to nothing.
//
// So clearing is allowed for the two slots the renderer already treats as
// optional — render.js emits the tagline and summary only `if (pos.tagline)` /
// `if (pos.summary)`, so an empty string removes the element rather than
// leaving a blank one — and refused everywhere else. `name` is NOT clearable: a
// résumé with no name on it is not a document anyone wants.

// "positioning" was here until the 2026-09-08 design sync removed the tagline
// from the masthead; it is no longer a set_text target at all.
const CLEARABLE = ["summary"];

export function isClearableTarget(target: string): boolean {
  return CLEARABLE.indexOf(target) !== -1;
}

/** True when this override is an instruction to REMOVE the slot's text, rather
 *  than to replace it. Whitespace counts: "   " is how a model spells empty. */
export function isClearRequest(target: string, value: string): boolean {
  return isClearableTarget(target) && value.trim() === "";
}
