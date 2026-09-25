// Session tools: character, voice, join/leave the voice channel, runtime settings.

import { t, tList } from '../i18n/index.js';
import { VOICES } from '../voices.js';
import { findCharacter, normalize } from '../text.js';
import { requesterPrivileged } from './access.js';
import { WORDS, failure, ownerGate, resolveVoiceChannel } from './helpers.js';
import { P, defineTool } from './registry.js';

// What the owner says when asking for another character; the character's own name counts as well.
const CHARACTER_WORDS = tList('tools.session.character_words');

/** The owner-gate words for switching to this character: the general words plus its name. */
function characterWords(character) {
	const own = normalize(character?.name ?? '')
		.split(' ')
		.filter((word) => word.length >= 3);
	return [...new Set([...CHARACTER_WORDS, ...own])];
}

export const tools = [
	defineTool({
		name: 'switch_character',
		description:
			'Changes the character/persona of the voice assistant. The live session is rebuilt with the new character. Owner and server ' +
			'administrators only.',
		parameters: P.obj({ name: P.str('Name of a saved character') }, ['name']),
		// Anybody but an administrator goes through the owner gate, which can ask the owner first.
		asks: true,
		async handler(args, deps, { name }) {
			const character = findCharacter(deps.store.list(), String(args.name ?? ''));
			if (!character) return { ok: false, spoken: t('tools.session.character_not_found', { name: args.name }) };
			// The persona is the whole room's, and /character is limited to administrators; a voice asking
			// for it is held to the same standard. An administrator is recognised the way the slash commands
			// recognise one (src/auth.js), by the person whose line asked. Anybody else needs the owner's own
			// voice asking for it, which is also what lets the owner through when their line was not named.
			if (!(await requesterPrivileged(deps))) {
				const denied = await ownerGate(deps, characterWords(character), name);
				if (denied) return denied;
			}
			await deps.store.setActive(character.id);
			deps.log?.(t('tools.session.log_character_changed', { character: character.name }));
			await deps.refreshPersona?.(t('tools.session.persona_reason_character', { character: character.name }));
			return { ok: true, spoken: t('tools.session.character_switched', { character: character.name }), data: { character: character.name } };
		},
	}),

	defineTool({
		name: 'list_characters',
		description: 'Lists the saved characters and which one is active.',
		async handler(args, deps) {
			const characters = deps.store.list();
			const active = deps.store.getActive();
			const names = characters.map((c) => (c.id === active?.id ? t('tools.session.character_active', { name: c.name }) : c.name));
			return {
				ok: true,
				spoken: names.length ? t('tools.session.characters', { names: names.join(', ') }) : t('tools.session.characters_empty'),
				data: { characters: names },
			};
		},
	}),

	defineTool({
		name: 'join_voice',
		description: 'Joins a voice channel.',
		parameters: P.obj({ channel: P.str('Voice channel name (empty = the channel of the person speaking)') }),
		async handler(args, deps) {
			const target = resolveVoiceChannel(deps, args.channel) ?? deps.currentSpeakerChannel?.() ?? null;
			if (!target) return { ok: false, spoken: t('tools.session.no_voice_channel') };
			try {
				await deps.joinVoice(target);
				deps.log?.(t('tools.session.log_joined', { channel: target.name }));
				return { ok: true, spoken: t('tools.session.joined', { channel: target.name }), data: { channel: target.name } };
			} catch (err) {
				return failure(deps, 'voice channel join failed', err, t('tools.session.join_failed'));
			}
		},
	}),

	defineTool({
		name: 'leave_voice',
		description: 'Leaves the voice channel.',
		async handler(args, deps) {
			// Leaving is delayed a little so the model can say goodbye; otherwise the session closes
			// and the last sentence is cut off before anyone hears it.
			// If the owner told it to leave the departure is permanent; if the model decided by itself it comes back shortly.
			const permanent = deps.isOwnerActive?.() === true;
			const delay = Math.max(0, deps.cfg?.leaveDelayMs ?? 2500);
			const timer = setTimeout(() => {
				Promise.resolve(deps.leaveVoice?.({ permanent })).catch(() => {});
			}, delay);
			if (typeof timer.unref === 'function') timer.unref();
			const seconds = (delay / 1000).toFixed(1);
			deps.log?.(permanent ? t('tools.session.log_leaving', { seconds }) : t('tools.session.log_leaving_temporary', { seconds }));
			return { ok: true, spoken: t('tools.session.leaving'), data: { leave_in_ms: delay, permanent } };
		},
	}),

	defineTool({
		name: 'set_voice',
		description: `Changes the bot's voice. Options: ${VOICES.join(', ')}. Owner only.`,
		parameters: P.obj({ voice: { type: 'string', enum: VOICES, description: 'Voice name' } }, ['voice']),
		gate: { keywords: WORDS.voice },
		async handler(args, deps) {
			const voice = String(args.voice ?? '').trim().toLowerCase();
			if (!VOICES.includes(voice)) {
				return { ok: false, spoken: t('tools.session.unknown_voice', { voice, options: VOICES.join(', ') }) };
			}
			const active = deps.store.getActive();
			if (active) await deps.store.update(active.id, { voice });
			else deps.setDefaultVoice?.(voice);
			await deps.refreshPersona?.(t('tools.session.persona_reason_voice', { voice }));
			deps.log?.(t('tools.session.log_voice_changed', { voice }));
			return { ok: true, spoken: t('tools.session.voice_set', { voice }), data: { voice } };
		},
	}),

	defineTool({
		name: 'set_setting',
		description:
			'Changes a runtime setting (transcripts, announce_speaker, owner_priority, idle_close_minutes, local_tts, record, quiet). Owner only. quiet stops the bot speaking until the owner lifts it.',
		parameters: P.obj(
			{
				name: P.str('Setting name'),
				value: P.str('New value ("on"/"off", a number, and so on)'),
			},
			['name', 'value'],
		),
		gate: { keywords: WORDS.setting },
		async handler(args, deps) {
			const applied = await deps.applySetting?.(String(args.name ?? ''), args.value);
			const known = deps.settingNames?.() ?? [];
			if (applied === null || applied === undefined) {
				return {
					ok: false,
					spoken: t('tools.session.unknown_setting', { name: args.name, known: known.join(', ') || t('tools.session.no_settings') }),
				};
			}
			if (applied && typeof applied === 'object' && applied.ok === false) {
				return { ok: false, spoken: applied.spoken ?? t('tools.session.setting_failed', { name: args.name }) };
			}
			const value = applied && typeof applied === 'object' ? applied.value : applied;
			const shown = typeof value === 'boolean' ? (value ? t('tools.session.on') : t('tools.session.off')) : String(value);
			// A setting may bring its own line: "quiet" is the bot's own voice, not a name and a value.
			const spoken = (applied && typeof applied === 'object' && applied.spoken) || t('tools.session.setting_set', { name: args.name, value: shown });
			deps.log?.(t('tools.session.log_setting', { name: args.name, value: shown }));
			return { ok: true, spoken, data: { name: String(args.name), value } };
		},
	}),
];
