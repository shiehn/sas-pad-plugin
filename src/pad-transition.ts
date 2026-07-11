/**
 * Pad transition-group adapter — verbatim GROUP fades for pad stacks.
 *
 * A pad is a voice GROUP of 1..4 rotating patches, so the synth-style 1:1
 * MIDI crossfade is undefined between two pad groups. Registering this
 * adapter flips the pad panel's Transition Designer to the SDK's FADE-ONLY
 * board: one cell per PAD GROUP (anchor-addressed), and Create copies every
 * patch VERBATIM (exact MIDI clamped to the transition span + exact preset +
 * FX chain — NO LLM) into the transition scene, fading the whole group under
 * one slider.
 *
 * Unlike the bass adapter (staggered 0.35/0.65 so two basses never stack in
 * the low end), pad fades default to a SYMMETRIC 0.5/0.5 crossing —
 * overlapping washes are the pad aesthetic, and register 48-76 has no mud
 * concern.
 */

import type {
  PluginHost,
  PanelTransitionGroupAdapter,
  SceneFamilyTrack,
  VerbatimFadeMember,
} from '@signalsandsorcery/plugin-sdk';
import { parseTrackGroups } from '@signalsandsorcery/plugin-sdk';
import { PAD_VOICE_META_KEY, padVoiceGroupSpec, type PadVoiceMeta } from './pad-voice-meta';

/** Header/cell label for a pad subject or group-fade row. */
export function padGroupLabel(memberCount: number): string {
  return `Pads (${memberCount} ${memberCount === 1 ? 'patch' : 'patches'})`;
}

async function readSceneGroups(
  host: PluginHost,
  sceneId: string
): Promise<Array<{ groupId: string; members: Array<{ dbId: string; meta: PadVoiceMeta }> }>> {
  const sceneData = (await host.getAllSceneData(sceneId)) as Record<string, unknown>;
  return parseTrackGroups(sceneData, padVoiceGroupSpec);
}

export function createPadTransitionGroupAdapter(host: PluginHost): PanelTransitionGroupAdapter {
  return {
    fadeOnly: true,

    // One designer cell per pad group: the subject carries the ANCHOR's dbId
    // (exclude/row keys stay member-source-exact) and the anchor's prompt as
    // its primary label. Loose pad tracks (no group meta) pass through.
    async mapColumnSubjects(
      sceneId: string,
      tracks: SceneFamilyTrack[]
    ): Promise<SceneFamilyTrack[]> {
      const groups = await readSceneGroups(host, sceneId);
      const byDbId = new Map(tracks.map((t) => [t.dbId, t]));
      const memberDbIds = new Set<string>();
      const subjects: SceneFamilyTrack[] = [];

      for (const group of groups) {
        const liveMembers = group.members.filter((m) => byDbId.has(m.dbId));
        if (liveMembers.length === 0) continue;
        const anchor = liveMembers.find((m) => m.meta.voiceIndex === 0) ?? liveMembers[0];
        const anchorTrack = byDbId.get(anchor.dbId);
        for (const m of liveMembers) memberDbIds.add(m.dbId);
        subjects.push({
          dbId: anchor.dbId,
          name: padGroupLabel(liveMembers.length),
          role: anchorTrack?.role ?? 'pads',
          prompt: anchorTrack?.prompt,
        });
      }

      const loose = tracks.filter((t) => !memberDbIds.has(t.dbId));
      return [...subjects, ...loose];
    },

    // Anchor dbId → ordered members. A loose track expands to itself.
    async expandSubject(sceneId: string, subjectDbId: string): Promise<VerbatimFadeMember[]> {
      const [groups, familyTracks] = await Promise.all([
        readSceneGroups(host, sceneId),
        host.listSceneFamilyTracks ? host.listSceneFamilyTracks(sceneId) : Promise.resolve([]),
      ]);
      const nameById = new Map(familyTracks.map((t) => [t.dbId, t]));
      const group = groups.find((g) => g.groupId === subjectDbId);

      if (!group) {
        const track = nameById.get(subjectDbId);
        if (!track) return [];
        return [
          {
            dbId: track.dbId,
            name: track.name,
            role: track.role ?? 'pads',
            memberIndex: 0,
          },
        ];
      }

      return group.members
        .filter((m) => nameById.has(m.dbId))
        .sort((a, b) => a.meta.voiceIndex - b.meta.voiceIndex)
        .map((m) => {
          const track = nameById.get(m.dbId);
          return {
            dbId: m.dbId,
            name: track?.name ?? m.dbId,
            role: track?.role ?? 'pads',
            memberIndex: m.meta.voiceIndex,
            memberLabel: m.meta.label || undefined,
            familyMeta: m.meta,
          };
        });
    },

    // Give the COPIES their own padVoice metas (groupId = the new anchor's
    // dbId) so the Tracks view renders them as a proper pad group if the
    // fade metas are ever removed.
    async writeGroupMetas(
      transitionSceneId: string,
      copies: Array<{ newDbId: string; member: VerbatimFadeMember }>,
      newAnchorDbId: string
    ): Promise<void> {
      for (const { newDbId, member } of copies) {
        const src = member.familyMeta as PadVoiceMeta | undefined;
        const meta: PadVoiceMeta = {
          groupId: newAnchorDbId,
          voiceIndex: member.memberIndex,
          label: src?.label ?? member.memberLabel ?? '',
        };
        await host.setSceneData(transitionSceneId, `track:${newDbId}:${PAD_VOICE_META_KEY}`, meta);
      }
    },

    cleanupKeySuffixes: [PAD_VOICE_META_KEY],
    // Symmetric crossing — overlapping washes ARE the pad transition.
    defaultSliderPos: () => 0.5,
    // No LLM in a verbatim fade — pace the bar for engine copy work only.
    fadeEstimateMs: 4000,
    groupRowLabel: padGroupLabel,
  };
}
