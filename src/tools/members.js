// Member tools: move, voice channel roster, roles, activity, info, nickname, microphone.

import {
	WORDS,
	displayName,
	failure,
	findMember,
	isRelativeTarget,
	memberVoiceChannel,
	pickRelativeVoiceChannel,
	relativeDirection,
	resolveVoiceChannel,
	trDate,
} from './helpers.js';
import { t } from '../i18n/index.js';
import { P, defineTool } from './registry.js';

export const tools = [
	defineTool({
		name: 'move_member',
		description:
			'Moves (drags) a member into a voice channel. The target may also be relative, such as "the room below" / "the room above"; the bot can come along if asked. Owner only.',
		parameters: P.obj(
			{
				member: P.str('Name of the person to move'),
				channel: P.str('Target voice channel name, or "the room below" / "the room above"'),
				come_along: P.bool('Should the bot move to that channel too (default true)'),
			},
			['member', 'channel'],
		),
		gate: { keywords: WORDS.move },
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: args.member }) };
			const from = memberVoiceChannel(deps, member);
			if (!from) {
				return { ok: false, spoken: t('tools.members.not_in_voice', { who: displayName(member, t('tools.members.that_person')) }) };
			}

			let target = null;
			if (isRelativeTarget(args.channel)) {
				target = pickRelativeVoiceChannel(deps.guild, from, relativeDirection(args.channel));
				if (!target) {
					return {
						ok: false,
						spoken:
							relativeDirection(args.channel) === 'up'
								? t('tools.members.no_channel_above')
								: t('tools.members.no_channel_below'),
					};
				}
			} else {
				target = resolveVoiceChannel(deps, String(args.channel ?? ''));
				if (!target) return { ok: false, spoken: t('tools.members.voice_channel_not_found', { name: args.channel }) };
			}

			const who = displayName(member);
			try {
				await member.voice.setChannel(target, t('tools.helpers.audit_reason'));
			} catch (err) {
				return failure(deps, 'member move failed', err, t('tools.members.move_failed', { who }));
			}

			const comeAlong = args.come_along !== false;
			if (comeAlong && deps.joinVoice) {
				try {
					await deps.joinVoice(target);
				} catch (err) {
					deps.log?.(t('tools.members.log_join_failed', { error: err.message }));
				}
			}
			deps.log?.(t(comeAlong ? 'tools.members.log_moved_with_bot' : 'tools.members.log_moved', { who, channel: target.name }));
			return {
				ok: true,
				spoken: comeAlong
					? t('tools.members.moved_with_bot', { who, channel: target.name })
					: t('tools.members.moved', { who, channel: target.name }),
				data: { member: who, channel: target.name, came_along: comeAlong },
			};
		},
	}),

	defineTool({
		name: 'list_voice_members',
		description: 'Says who is in a voice channel right now.',
		parameters: P.obj({ channel: P.str('Voice channel name (when empty: the channel the bot is in)') }),
		async handler(args, deps) {
			const channel = resolveVoiceChannel(deps, args.channel) ?? deps.currentVoiceChannel?.() ?? null;
			if (!channel) return { ok: false, spoken: t('tools.members.which_voice_channel') };

			const states = [...deps.guild.voiceStates.cache.values()].filter((state) => state.channelId === channel.id);
			const names = [];
			for (const state of states) {
				let member = state.member ?? deps.guild.members.cache.get(state.id);
				// If the account name is missing (partial member), complete it by fetching that one member; a single
				// fetch does not need an intent.
				if (!member?.user?.username) {
					member = (await deps.guild.members.fetch(state.id).catch(() => null)) ?? member;
				}
				if (member?.user?.bot) continue;
				const display = displayName(member, state.id);
				const account = member?.user?.username ?? null;
				names.push(
					account && account.toLowerCase() !== display.toLowerCase()
						? t('tools.members.name_with_account', { display, account })
						: display,
				);
			}
			deps.log?.(t('tools.members.log_voice_members', { channel: channel.name, names: names.join(', ') || t('tools.members.none') }));
			return {
				ok: true,
				spoken: names.length
					? t('tools.members.in_channel', { channel: channel.name, names: names.join(', ') })
					: t('tools.members.channel_empty', { channel: channel.name }),
				data: { channel: channel.name, members: names },
			};
		},
	}),

	defineTool({
		name: 'member_roles',
		description: 'Lists a member\'s roles. Leave member empty for whoever is speaking ("what are my roles").',
		parameters: P.obj({ member: P.str('Person name; empty = the current speaker') }),
		async handler(args, deps) {
			// "What are my roles" arrives with an empty name, and looking up an empty string failed with
			// "I could not find anyone called ''". Empty means the person talking, as it does for user_info.
			const asked = String(args.member ?? '').trim();
			const member = asked ? await findMember(deps, asked) : await findMember(deps, String(deps.currentSpeakerId?.() ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: asked || t('tools.members.you') }) };
			const roles = [...(member.roles?.cache?.values() ?? [])]
				.filter((role) => role.name !== '@everyone')
				.sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
				.map((role) => role.name);
			const who = displayName(member);
			deps.log?.(t('tools.members.log_roles', { who, roles: roles.join(', ') || t('tools.members.none') }));
			return {
				ok: true,
				spoken: roles.length
					? t('tools.members.roles_list', { who, roles: roles.join(', ') })
					: t('tools.members.roles_empty', { who }),
				data: { member: who, roles },
			};
		},
	}),

	defineTool({
		name: 'member_activity',
		description: 'Says what a member is listening to (Spotify) or which game they are playing (needs the PRESENCE intent).',
		parameters: P.obj({ member: P.str('Person name') }, ['member']),
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: args.member }) };
			if (deps.presenceEnabled === false) {
				return { ok: false, spoken: t('tools.members.presence_off') };
			}
			const who = displayName(member);
			const activities = [...(member.presence?.activities ?? [])];

			const listening = activities.find(
				(activity) => (activity.name === 'Spotify' || activity.type === 2) && (activity.details || activity.state),
			);
			if (listening) {
				const track = listening.details ?? null;
				const artist = listening.state ?? null;
				const what = [track, artist].filter(Boolean).join(' - ');
				deps.log?.(t('tools.members.log_listening', { who, what }));
				return {
					ok: true,
					spoken: t(listening.name === 'Spotify' ? 'tools.members.listening_spotify' : 'tools.members.listening', { who, what }),
					data: { member: who, kind: 'listening', track, artist, source: listening.name },
				};
			}

			const playing = activities.find((activity) => activity.type === 0 && activity.name);
			if (playing) {
				deps.log?.(t('tools.members.log_playing', { who, game: playing.name }));
				return {
					ok: true,
					spoken: t('tools.members.playing', { who, game: playing.name }),
					data: { member: who, kind: 'playing', game: playing.name },
				};
			}

			const custom = activities.find((activity) => activity.type === 4 && (activity.state || activity.details));
			if (custom) {
				const text = custom.state ?? custom.details;
				return { ok: true, spoken: t('tools.members.status', { who, text }), data: { member: who, kind: 'status', text } };
			}

			return {
				ok: true,
				spoken: t('tools.members.activity_none', { who }),
				data: { member: who, kind: null },
			};
		},
	}),

	defineTool({
		name: 'user_info',
		description:
			'Gives the details of a member: nickname, roles, the date they joined the server. Accepts a name, a ' +
			'mention or a user id; leave member empty for whoever is speaking. You are already told who is ' +
			'speaking, so you do not need this to answer "who am I".',
		parameters: P.obj({ member: P.str('Person name, mention or id; empty = the current speaker') }),
		async handler(args, deps) {
			// Empty means "the person talking to me": the model asks that a lot, and looking up an empty
			// string used to fail with "I could not find anyone called ''".
			const asked = String(args.member ?? '').trim();
			const member = asked ? await findMember(deps, asked) : await findMember(deps, String(deps.currentSpeakerId?.() ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: asked || t('tools.helpers.someone') }) };
			const roles = [...(member.roles?.cache?.values?.() ?? [])]
				.filter((role) => role.name !== '@everyone')
				.map((role) => role.name);
			const rolesText = roles.length ? t('tools.members.user_info_roles', { roles: roles.join(', ') }) : t('tools.members.user_info_no_roles');
			return {
				ok: true,
				spoken: t(member.nickname ? 'tools.members.user_info_with_nickname' : 'tools.members.user_info', {
					name: member.displayName,
					nickname: member.nickname,
					roles: rolesText,
					joined: trDate(member.joinedAt),
				}),
				data: {
					id: member.id,
					displayName: member.displayName,
					nickname: member.nickname ?? null,
					roles,
					joinedAt: member.joinedAt?.toISOString?.() ?? null,
				},
			};
		},
	}),

	defineTool({
		name: 'set_nickname',
		description: 'Changes or clears a member\'s nickname. Owner only.',
		parameters: P.obj(
			{
				member: P.str('Person name'),
				nickname: P.str('New nickname (cleared when left empty)'),
			},
			['member'],
		),
		gate: { keywords: WORDS.name },
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: args.member }) };
			const nickname = args.nickname ? String(args.nickname).trim().slice(0, 32) : null;
			try {
				await member.setNickname(nickname, t('tools.helpers.audit_reason'));
				deps.log?.(
					nickname
						? t('tools.members.log_nickname_set', { nickname, who: member.displayName })
						: t('tools.members.log_nickname_cleared', { who: member.displayName }),
				);
				return {
					ok: true,
					spoken: nickname
						? t('tools.members.nickname_set', { who: member.displayName, nickname })
						: t('tools.members.nickname_cleared', { who: member.displayName }),
					data: { id: member.id, nickname },
				};
			} catch (err) {
				return failure(deps, 'nickname unchanged', err, t('tools.members.nickname_failed'));
			}
		},
	}),

	defineTool({
		name: 'voice_mute',
		description:
			'Server-mutes or server-deafens a member who is in a voice channel, or undoes it. This silences them but leaves ' +
			'them in the channel; use voice_disconnect to throw them out of the voice channel, and kick_member to remove them ' +
			'from the server. Owner only.',
		parameters: P.obj(
			{
				member: P.str('Person name'),
				mute: P.bool('Turn the microphone off (default: true)'),
				deafen: P.bool('Turn the headphones off (optional)'),
			},
			['member'],
		),
		gate: { keywords: WORDS.voice },
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: args.member }) };
			// In discord.js member.voice is always a VoiceState object; whether they are in a channel shows in channelId.
			if (!member.voice || !(member.voice.channelId ?? member.voice.channel)) {
				return { ok: false, spoken: t('tools.members.not_in_voice', { who: member.displayName }) };
			}
			const mute = args.mute !== false;
			const deafen = typeof args.deafen === 'boolean' ? args.deafen : undefined;
			try {
				await member.voice.setMute(mute, t('tools.helpers.audit_reason'));
				// discord.js names this setDeaf (not setDeafen); calling the wrong one threw and the whole tool failed.
				if (deafen !== undefined) await member.voice.setDeaf(deafen, t('tools.helpers.audit_reason'));
				deps.log?.(t(mute ? 'tools.members.log_muted' : 'tools.members.log_unmuted', { who: member.displayName }));
				return {
					ok: true,
					spoken: mute ? t('tools.members.muted', { who: member.displayName }) : t('tools.members.unmuted', { who: member.displayName }),
					data: { id: member.id, mute, deafen: deafen ?? null },
				};
			} catch (err) {
				return failure(deps, 'voice state unchanged', err, t('tools.members.voice_state_failed'));
			}
		},
	}),

	defineTool({
		name: 'voice_disconnect',
		description:
			'Throws a member OUT OF THE VOICE CHANNEL (disconnects them). They stay in the server and can come back; this is ' +
			'not a kick. For removing somebody from the server use kick_member, and to silence them without moving them use ' +
			'voice_mute. Owner only.',
		parameters: P.obj({ member: P.str('Person name'), reason: P.str('Reason (optional)') }, ['member']),
		gate: { keywords: WORDS.kick },
		async handler(args, deps) {
			const member = await findMember(deps, String(args.member ?? ''));
			if (!member) return { ok: false, spoken: t('tools.members.member_not_found', { name: args.member }) };
			const channel = member.voice?.channel ?? null;
			if (!member.voice || !(member.voice.channelId ?? channel)) {
				return { ok: false, spoken: t('tools.members.not_in_voice', { who: displayName(member) }) };
			}
			try {
				// Setting the voice channel to null is what "disconnect" means in the Discord API.
				await member.voice.setChannel(null, args.reason ? String(args.reason).slice(0, 400) : t('tools.helpers.audit_reason'));
				deps.log?.(t('tools.members.log_disconnected', { who: displayName(member), channel: channel?.name ?? '?' }));
				return {
					ok: true,
					spoken: t('tools.members.disconnected', { who: displayName(member), channel: channel?.name ?? '?' }),
					data: { id: member.id, from: channel?.name ?? null },
				};
			} catch (err) {
				return failure(deps, 'voice disconnect failed', err, t('tools.members.disconnect_failed'));
			}
		},
	}),
];
