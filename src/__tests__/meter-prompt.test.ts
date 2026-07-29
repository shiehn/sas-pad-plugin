/**
 * Meter-awareness of the pad system prompt + slot grid (P8b multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshot below was recorded from the PRE-meter
 * implementation (`buildPadSystemPrompt(slots, voicing)` with no meter
 * parameter, grid built with the implicit 4-qn bar). After the meter
 * parameter landed, the 4/4 prompt — with the parameter omitted OR passed
 * explicitly as '4/4' — must still match that snapshot byte-for-byte.
 * Never `--ci`-update this snapshot as part of a meter change; a diff here
 * means 4/4 behavior drifted.
 */
import { buildPadSystemPrompt } from '../pad-prompt';
import { buildPadSlotGrid, type PadChordTiming } from '../pad-patterns';

const CHORDS_4_4: PadChordTiming[] = [
  { symbol: 'Am', startQn: 0, endQn: 8 },
  { symbol: 'F', startQn: 8, endQn: 16 },
];

function grid44(): ReturnType<typeof buildPadSlotGrid> {
  return buildPadSlotGrid({
    bars: 4,
    voiceCount: 2,
    duration: 'whole',
    rests: 'off',
    chordTiming: CHORDS_4_4,
  });
}

describe('buildPadSystemPrompt — 4/4 byte identity', () => {
  it('4/4 output is byte-identical to the pre-meter prompt (snapshot pin)', () => {
    const grid = grid44();
    expect(buildPadSystemPrompt(grid.voicingSlots, 'full')).toMatchSnapshot('full-voicing');
    expect(buildPadSystemPrompt(grid.voicingSlots, 'partial')).toMatchSnapshot('partial-voicing');
  });

  it("omitted, explicit '4/4', and unparseable meters all produce the identical legacy prompt", () => {
    const grid = grid44();
    const legacy = buildPadSystemPrompt(grid.voicingSlots, 'full');
    expect(buildPadSystemPrompt(grid.voicingSlots, 'full', '4/4')).toBe(legacy);
    expect(buildPadSystemPrompt(grid.voicingSlots, 'full', 'waltz')).toBe(legacy);
    expect(buildPadSystemPrompt(grid.voicingSlots, 'full', '')).toBe(legacy);
  });
});

describe('buildPadSystemPrompt — non-4/4 meters', () => {
  it('6/8 slots carry meter-derived bar spans and the compound meter rules are appended', () => {
    const chords: PadChordTiming[] = [{ symbol: 'Am', startQn: 0, endQn: 12 }];
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 2,
      duration: 'whole',
      rests: 'off',
      chordTiming: chords,
      quarterNotesPerBar: 3, // 6/8
    });
    const prompt = buildPadSystemPrompt(grid.voicingSlots, 'full', '6/8');
    // Slot lines are in the meter's quarter notes: bar 2 starts at qn 3.
    expect(prompt).toContain('slot 1: bar 2, beats 3-6, chord Am');
    // SDK family rules + the pad-side qn clarifier.
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    expect(prompt).toContain('QUARTER-NOTE offsets from the clip start');
  });

  it('7/8 slot spans stay exact on the fractional (3.5 qn) bar', () => {
    const chords: PadChordTiming[] = [{ symbol: 'F', startQn: 0, endQn: 7 }];
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 2,
      duration: 'whole',
      rests: 'off',
      chordTiming: chords,
      quarterNotesPerBar: 3.5, // 7/8
    });
    const prompt = buildPadSystemPrompt(grid.voicingSlots, 'full', '7/8');
    expect(prompt).toContain('slot 0: bar 1, beats 0-3.5, chord F');
    expect(prompt).toContain('slot 1: bar 2, beats 3.5-7, chord F');
    expect(prompt).toContain('Time signature 7/8 — meter rules:');
    expect(prompt).toContain('2+2+3');
  });
});
