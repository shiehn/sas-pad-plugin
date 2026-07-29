/**
 * The slot grid under non-4/4 meters (P8b): base-slot spans, pattern scaling,
 * half-bar rests, bar attribution, and rotation stability — including the
 * FRACTIONAL qn-per-bar audit (7/8 → 3.5): every strike boundary must land
 * exactly (dyadic arithmetic, no FP drift) and slot counts stay integral.
 *
 * The legacy 4/4 grid behavior is covered by pad-patterns.test.ts — those
 * tests run unmodified (omitted `quarterNotesPerBar` = the 4/4 grid).
 */

import { buildPadSlotGrid, type PadChordTiming } from '../pad-patterns';

const chord = (endQn: number): PadChordTiming[] => [{ symbol: 'Am', startQn: 0, endQn }];

describe('whole mode across meters', () => {
  it('3/4: one 3-qn strike per bar, rotation bar-indexed exactly as in 4/4', () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 2,
      duration: 'whole',
      rests: 'off',
      chordTiming: chord(12),
      quarterNotesPerBar: 3,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex, s.bar])).toEqual([
      [0, 3, 0, 0],
      [3, 3, 1, 1],
      [6, 3, 0, 2],
      [9, 3, 1, 3],
    ]);
  });

  it('7/8 (fractional 3.5 qn bars): strike boundaries and bar attribution are exact', () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 3,
      duration: 'whole',
      rests: 'off',
      chordTiming: chord(14),
      quarterNotesPerBar: 3.5,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex, s.bar])).toEqual([
      [0, 3.5, 0, 0],
      [3.5, 3.5, 1, 1],
      [7, 3.5, 2, 2],
      [10.5, 3.5, 0, 3],
    ]);
  });
});

describe('half mode across meters', () => {
  it('6/8: half-bar slots span 1.5 qn and the slot count stays integral', () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 3,
      duration: 'half',
      rests: 'off',
      chordTiming: chord(6),
      quarterNotesPerBar: 3,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex])).toEqual([
      [0, 1.5, 0],
      [1.5, 1.5, 1],
      [3, 1.5, 2],
      [4.5, 1.5, 0],
    ]);
  });

  it('7/8: half slots are 1.75 qn — the fractional bar bisects exactly', () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 2,
      duration: 'half',
      rests: 'off',
      chordTiming: chord(7),
      quarterNotesPerBar: 3.5,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.bar])).toEqual([
      [0, 1.75, 0],
      [1.75, 1.75, 0],
      [3.5, 1.75, 1],
      [5.25, 1.75, 1],
    ]);
  });
});

describe('rhythmic patterns scale as bar fractions', () => {
  it('6/8 pulsing-quarters: four even 0.75-qn pulses per bar', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'pulsing-quarters',
      rests: 'off',
      chordTiming: chord(3),
      quarterNotesPerBar: 3,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats])).toEqual([
      [0, 0.75],
      [0.75, 0.75],
      [1.5, 0.75],
      [2.25, 0.75],
    ]);
  });

  it('7/8 front-half: plays the first 1.75 qn of each bar, tiling both bars', () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 2,
      duration: 'rhythmic',
      patternId: 'front-half',
      rests: 'off',
      chordTiming: chord(7),
      quarterNotesPerBar: 3.5,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats, s.voiceIndex, s.bar])).toEqual([
      [0, 1.75, 0, 0],
      [3.5, 1.75, 1, 1],
    ]);
  });

  it('7/8 offbeat-stabs: 0.875-scaled segments stay exact (no FP drift)', () => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'rhythmic',
      patternId: 'offbeat-stabs',
      rests: 'off',
      chordTiming: chord(3.5),
      quarterNotesPerBar: 3.5,
    });
    // Authoring offsets 0.5/1.5/2.5/3.5 × scale 0.875 — all dyadic-exact.
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats])).toEqual([
      [0.4375, 0.4375],
      [1.3125, 0.4375],
      [2.1875, 0.4375],
      [3.0625, 0.4375],
    ]);
  });
});

describe('rests across meters', () => {
  it("3/4 'half-bar' rests: play the front 1.5 qn of each bar", () => {
    const grid = buildPadSlotGrid({
      bars: 2,
      voiceCount: 1,
      duration: 'whole',
      rests: 'half-bar',
      chordTiming: chord(6),
      quarterNotesPerBar: 3,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.durationBeats])).toEqual([
      [0, 1.5],
      [3, 1.5],
    ]);
  });

  it("sparse rests stay rotation-position-stable in 6/8 (every 4th slot rests)", () => {
    const grid = buildPadSlotGrid({
      bars: 4,
      voiceCount: 2,
      duration: 'whole',
      rests: 'sparse',
      chordTiming: chord(12),
      quarterNotesPerBar: 3,
    });
    expect(grid.strikes.map((s) => [s.startBeat, s.voiceIndex])).toEqual([
      [0, 0],
      [3, 1],
      [6, 0],
    ]);
  });
});

describe('chord splits across meters', () => {
  it('6/8 mid-bar chord change splits the bar slot at the boundary', () => {
    const timing: PadChordTiming[] = [
      { symbol: 'Am', startQn: 0, endQn: 1.5 },
      { symbol: 'F', startQn: 1.5, endQn: 3 },
    ];
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'whole',
      rests: 'off',
      chordTiming: timing,
      quarterNotesPerBar: 3,
    });
    expect(grid.voicingSlots.map((s) => [s.startBeat, s.endBeat, s.chordSymbol])).toEqual([
      [0, 1.5, 'Am'],
      [1.5, 3, 'F'],
    ]);
    expect(grid.strikes).toHaveLength(2);
  });
});

describe('invalid quarterNotesPerBar degrades to the 4/4 grid', () => {
  it.each([NaN, 0, -3, Infinity])('%p falls back to 4-qn bars', (bad) => {
    const grid = buildPadSlotGrid({
      bars: 1,
      voiceCount: 1,
      duration: 'whole',
      rests: 'off',
      chordTiming: chord(4),
      quarterNotesPerBar: bad,
    });
    expect(grid.strikes).toEqual([
      { startBeat: 0, durationBeats: 4, voiceIndex: 0, voicingSlotIndex: 0, bar: 0 },
    ]);
  });
});
