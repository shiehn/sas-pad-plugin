/**
 * Band-density style bullet (drum-interplay follow-on, 2026-07-30).
 *
 * The pad's ONLY density lever is notes-per-slot (the grid owns all timing),
 * so the prompt now tells the model to yield thickness to the band: lean
 * voicings where the listed drum/percussion tracks are busy, richer where
 * they rest — always inside the voicing mode's stated range. Presence +
 * phrasing pinned here for both voicing modes and across meters; the 4/4
 * byte identity itself lives in meter-prompt.test.ts.
 */
import { buildPadSystemPrompt } from '../pad-prompt';
import { buildPadSlotGrid, type PadChordTiming } from '../pad-patterns';

const CHORDS: PadChordTiming[] = [
  { symbol: 'Am', startQn: 0, endQn: 8 },
  { symbol: 'F', startQn: 8, endQn: 16 },
];

function slots(timeSignature?: string): ReturnType<typeof buildPadSlotGrid>['voicingSlots'] {
  return buildPadSlotGrid({
    bars: 4,
    voiceCount: 2,
    duration: 'whole',
    rests: 'off',
    chordTiming: CHORDS,
    ...(timeSignature ? { timeSignature } : {}),
  }).voicingSlots;
}

const SNIPPET = "Band density: the user message lists the other tracks' notes";

describe('pad band-density bullet', () => {
  it('is present in both voicing modes (4/4)', () => {
    for (const mode of ['full', 'partial'] as const) {
      const prompt = buildPadSystemPrompt(slots(), mode);
      expect(prompt).toContain(SNIPPET);
      expect(prompt).toContain('favor the LOW end of the allowed notes-per-slot');
      expect(prompt).toContain('Stay inside the stated notes-per-slot range either way.');
    }
  });

  it('rides along on non-4/4 meters too', () => {
    const prompt = buildPadSystemPrompt(slots('6/8'), 'full', '6/8');
    expect(prompt).toContain(SNIPPET);
  });

  it('never overrides the voicing mode ranges (both remain stated)', () => {
    const full = buildPadSystemPrompt(slots(), 'full');
    const partial = buildPadSystemPrompt(slots(), 'partial');
    expect(full).toContain('FULL voicing: 4-');
    expect(partial).toContain('PARTIAL voicing: 2-');
  });
});
