/**
 * The deterministic grid: rotation (including rests keeping their rotation
 * position), pattern tiling, rests composition, chord-boundary splits, and
 * voicing-slot coalescing.
 */

import {
  buildPadSlotGrid,
  padPatternById,
  PAD_PATTERNS,
  type PadChordTiming,
} from '../pad-patterns';

const ONE_CHORD: PadChordTiming[] = [{ symbol: 'Am', startQn: 0, endQn: 64 }];

describe('PAD_PATTERNS', () => {
  it('every pattern tiles exactly one 4-beat bar', () => {
    for (const p of PAD_PATTERNS) {
      const total = p.segments.reduce((a, s) => a + s.durationBeats, 0);
      expect({ id: p.id, total }).toEqual({ id: p.id, total: 4 });
    }
  });

  it('padPatternById falls back to the first pattern for unknown ids', () => {
    expect(padPatternById('nope').id).toBe(PAD_PATTERNS[0].id);
  });
});

describe('whole mode', () => {
  it('one strike per bar, rotating voices bar-by-bar', () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 2,
      duration: 'whole',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex])).toEqual([
      [0, 4, 0],
      [4, 4, 1],
      [8, 4, 0],
      [12, 4, 1],
    ]);
    // Same chord, but each bar is its own base slot → its own voicing slot.
    expect(grid.voicingSlots).toHaveLength(4);
  });

  it('voiceCount 1 puts everything on one patch', () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 1,
      duration: 'whole',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(grid.strikes.every((s) => s.voiceIndex === 0)).toBe(true);
  });
});

describe('half mode', () => {
  it('rotates per half-bar', () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 3,
      duration: 'half',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex])).toEqual([
      [0, 2, 0],
      [2, 2, 1],
      [4, 2, 2],
      [6, 2, 0],
    ]);
  });
});

describe('rests', () => {
  it('sparse rests every 4th base slot WITHOUT re-aligning the rotation', () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 2,
      duration: 'whole',
      rests: 'sparse',
      chordTiming: ONE_CHORD,
    });
    // Bar 4 (slot 3) rests; slots 0-2 keep their i % 2 voices.
    expect(grid.strikes.map((s) => [s.startBeat, s.voiceIndex])).toEqual([
      [0, 0],
      [4, 1],
      [8, 0],
    ]);
  });

  it('half-bar rests truncate each play slot to its first half', () => {
    const whole = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'whole',
      rests: 'half-bar',
      chordTiming: ONE_CHORD,
    });
    expect(whole.strikes).toHaveLength(1);
    expect(whole.strikes[0]).toMatchObject({ startBeat: 0, durationBeats: 2 });

    const half = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'half',
      rests: 'half-bar',
      chordTiming: ONE_CHORD,
    });
    expect(half.strikes.map((s) => [s.startBeat, s.durationBeats])).toEqual([
      [0, 1],
      [2, 1],
    ]);
  });

  it('rhythmic mode ignores the rests control (the pattern owns rests)', () => {
    const withRests = buildPadSlotGrid({
      bars: 4,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'pulsing-quarters',
      rests: 'sparse',
      chordTiming: ONE_CHORD,
    });
    const withoutRests = buildPadSlotGrid({
      bars: 4,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'pulsing-quarters',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(withRests.strikes).toEqual(withoutRests.strikes);
  });
});

describe('rhythmic patterns', () => {
  it('front-half plays beats 1-2 and rests 3-4, rotating per bar', () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 2,
      duration: 'rhythmic',
      patternId: 'front-half',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex])).toEqual([
      [0, 2, 0],
      [4, 2, 1],
    ]);
  });

  it('offbeat stabs share ONE voicing slot per bar over one chord', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'offbeat-stabs',
      rests: 'off',
      chordTiming: ONE_CHORD,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats])).toEqual([
      [0.5, 0.5],
      [1.5, 0.5],
      [2.5, 0.5],
      [3.5, 0.5],
    ]);
    expect(grid.voicingSlots).toHaveLength(1);
    expect(grid.strikes.every((s) => s.voicingSlotIndex === 0)).toBe(true);
  });
});

describe('chord boundaries', () => {
  const TWO_CHORDS_PER_BAR: PadChordTiming[] = [
    { symbol: 'Am', startQn: 0, endQn: 2 },
    { symbol: 'F', startQn: 2, endQn: 4 },
  ];

  it('splits a whole-bar strike at a mid-bar chord change and re-strikes', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 2,
      duration: 'whole',
      rests: 'off',
      chordTiming: TWO_CHORDS_PER_BAR,
    });
    expect(grid.voicingSlots.map((s) => s.chordSymbol)).toEqual(['Am', 'F']);
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voicingSlotIndex])).toEqual([
      [0, 2, 0],
      [2, 2, 1],
    ]);
    // Both halves of the split bar stay on the SAME patch — rotation is per
    // base slot, not per chord region.
    expect(grid.strikes.every((s) => s.voiceIndex === 0)).toBe(true);
  });

  it('labels chordless spans with a null symbol', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'whole',
      rests: 'off',
      chordTiming: [{ symbol: 'Am', startQn: 0, endQn: 2 }],
    });
    expect(grid.voicingSlots.map((s) => s.chordSymbol)).toEqual(['Am', null]);
  });

  it('pulsing quarters across a mid-bar change reuse per-region voicing slots', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'pulsing-quarters',
      rests: 'off',
      chordTiming: TWO_CHORDS_PER_BAR,
    });
    // 4 strikes but only 2 voicing slots (one per chord region of the bar).
    expect(grid.strikes).toHaveLength(4);
    expect(grid.voicingSlots).toHaveLength(2);
    expect(grid.strikes.map((s) => s.voicingSlotIndex)).toEqual([0, 0, 1, 1]);
  });
});
