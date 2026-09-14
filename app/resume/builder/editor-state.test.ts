import { describe, expect, it } from 'vitest';
import { moveItem, revisionReady } from '@/components/resume-builder/editor-state';

describe('resume editor operations', () => {
  it('reorders without removing any content or mutating saved data', () => {
    // Mutation caught: splice the original array instead of a copy.
    const source = [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }, { id: 'c', text: 'Third' }];
    expect(moveItem(source, 2, -1).map(x => x.id)).toEqual(['a', 'c', 'b']);
    expect(source.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(moveItem(source, 0, -1)).toEqual(source);
  });
  it('blocks revision-dependent actions until local edits are saved', () => {
    // Mutation caught: allow actions when dirty is true.
    expect(revisionReady(true, false, true)).toBe(false);
    expect(revisionReady(true, true, false)).toBe(false);
    expect(revisionReady(false, false, false)).toBe(false);
    expect(revisionReady(true, false, false)).toBe(true);
  });
});
