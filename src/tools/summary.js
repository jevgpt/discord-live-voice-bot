// Summary tool: "what was talked about today?" (via src/summary.js).

import { t } from '../i18n/index.js';
import { P, defineTool } from './registry.js';

/**
 * Who hears a spoken summary: the person who asked, and everyone else sitting in the voice channel with
 * the bot, since the answer is read out to the whole room. src/summary.js keeps a text channel only when
 * all of them may read it. A speaker the bot cannot place (nobody has spoken yet, a member it has not
 * cached) goes in as null, which src/summary.js judges as @everyone.
 */
export function listenersOf(deps) {
	const guild = deps.guild ?? null;
	const speakerId = deps.currentSpeakerId?.() ?? null;
	const speaker = speakerId ? (guild?.members?.cache?.get?.(String(speakerId)) ?? null) : null;
	const readers = [speaker];
	const room = deps.currentVoiceChannel?.() ?? null;
	for (const member of room?.members?.values?.() ?? []) {
		if (!member || member.user?.bot || member.id === speaker?.id) continue;
		readers.push(member);
	}
	return readers;
}

export const tools = [
	defineTool({
		name: 'summarize_conversation',
		description:
			'Briefly summarises the voice channel and text channel conversations from the last few hours, in this server only. Text channels that not everyone listening may read are left out.',
		parameters: P.obj({ hours: P.int('How many hours back (default 3, 0 = the whole log)') }),
		async handler(args, deps) {
			if (typeof deps.summarize !== 'function') return { ok: false, spoken: t('tools.summary.disabled') };
			const hours = Number.isFinite(Number(args.hours)) ? Math.max(0, Math.min(72, Number(args.hours))) : 3;
			const { summary, count } = await deps.summarize({ hours, spoken: true, audience: { readers: listenersOf(deps) } });
			return { ok: count > 0, spoken: summary, data: { hours, events: count } };
		},
	}),
];
