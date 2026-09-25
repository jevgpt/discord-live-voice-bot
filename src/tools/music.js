// Music tools: the bot's own player (src/music.js). Music ducks by itself while the bot speaks.
//
// All of them are open to everybody, like play/stop/skip always were: the worst any of them does is to
// somebody else's listening, and stop_music -- which clears the whole queue -- set that bar long ago.

import { t } from '../i18n/index.js';
import {
	LOOP_MODES,
	MAX_SEEK_SECONDS,
	QUEUE_FULL,
	SEEK_OUT_OF_RANGE,
	SEEK_PAST_END,
	SEEK_UNSUPPORTED,
	UNSUPPORTED_LINK,
	YTDLP_MISSING,
	parseSeekTarget,
} from '../music.js';
import { MAX_SAVED_PER_USER, pickSaved } from '../savedtracks.js';
import { formatClock } from '../text.js';
import { P, defineTool } from './registry.js';

/** The player is not wired up (.env: MUSIC=0); every music tool answers the same way. */
function noMusic() {
	return { ok: false, spoken: t('tools.music.disabled') };
}

function musicEvent(deps, text, meta = {}) {
	deps.activity?.({ kind: 'music', whoName: deps.personaName?.() ?? 'bot', text, meta });
}

/** Who is asking: saved lists and "I meant this one" belong to people, not to the channel. */
function speakerOf(deps) {
	const id = deps.currentSpeakerId?.() ?? null;
	return { id: id ? String(id) : null, name: deps.currentSpeakerName?.() ?? null };
}

/** yt-dlp's stderr can echo back what a fetched page said, so only our own reasons are spoken. */
function playFailure(err, deps) {
	deps.log?.(t('tools.music.log_play_failed', { error: err.message }));
	if (err.message === UNSUPPORTED_LINK) return { ok: false, spoken: t('tools.music.unsupported_link') };
	if (err.message === QUEUE_FULL) return { ok: false, spoken: t('tools.music.queue_full') };
	if (err.message === YTDLP_MISSING) return { ok: false, spoken: t('tools.music.ytdlp_missing') };
	return { ok: false, spoken: t('tools.music.play_failed_generic') };
}

/** play_music and play_next: the same lookup, the track going to the back of the queue or to its front. */
async function queueTrack(args, deps, { next = false } = {}) {
	if (!deps.music) return noMusic();
	const query = String(args.query ?? '').trim();
	if (!query) return { ok: false, spoken: t('tools.music.no_query') };
	try {
		const { track, position, startedNow, duplicate, moved } = await deps.music.enqueue(query, {
			requestedBy: deps.currentSpeakerName?.() ?? null,
			...(next ? { next: true } : {}),
		});
		const label = `${track.title}${track.uploader ? ` — ${track.uploader}` : ''}`;
		if (duplicate) {
			return {
				ok: true,
				spoken: t('tools.music.already_queued', { title: track.title }),
				data: { title: track.title, duplicate: true, position },
			};
		}
		const event = startedNow
			? t('tools.music.playing_event', { label })
			: next
				? t('tools.music.queued_next_event', { label })
				: t('tools.music.queued_event', { position, label });
		musicEvent(deps, event, { query, source: track.kind });
		const spoken = startedNow
			? t('tools.music.playing', { title: track.title })
			: moved
				? t('tools.music.moved_up', { title: track.title })
				: next
					? t('tools.music.queued_next', { title: track.title })
					: t('tools.music.queued', { position, title: track.title });
		return {
			ok: true,
			spoken,
			data: { title: track.title, uploader: track.uploader, duration: track.duration, position, started_now: startedNow, ...(moved ? { moved: true } : {}) },
		};
	} catch (err) {
		return playFailure(err, deps);
	}
}

/** "nothing playing" for the tools that act on the current track. */
function nothingPlaying() {
	return { ok: false, spoken: t('tools.music.nothing_playing') };
}

export const tools = [
	defineTool({
		name: 'play_music',
		description:
			'Plays a song or track: a YouTube search (song title + artist) or a direct link. If something is already playing it is queued instead. Music is ducked while the bot speaks.',
		parameters: P.obj({ query: P.str('Song title (+ artist) or URL') }, ['query']),
		handler: (args, deps) => queueTrack(args, deps),
	}),

	defineTool({
		name: 'play_next',
		description:
			'Puts a song at the FRONT of the queue, so it plays right after the current track ("play X next", "after this one play X"). ' +
			'Starts it at once when nothing is playing. A track that is already waiting is moved up rather than added twice.',
		parameters: P.obj({ query: P.str('Song title (+ artist) or URL') }, ['query']),
		handler: (args, deps) => queueTrack(args, deps, { next: true }),
	}),

	defineTool({
		name: 'stop_music',
		description: 'Stops the music and clears the queue.',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const stopped = deps.music.stop();
			if (!stopped) return { ok: true, spoken: t('tools.music.not_playing') };
			musicEvent(deps, t('tools.music.stopped_event', { title: stopped.title }));
			return { ok: true, spoken: t('tools.music.stopped'), data: { title: stopped.title } };
		},
	}),

	defineTool({
		name: 'pause_music',
		description: 'Pauses the music (it can be resumed from where it left off).',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			if (!deps.music.pause()) return { ok: false, spoken: t('tools.music.nothing_playing') };
			deps.log?.(t('tools.music.log_paused'));
			musicEvent(deps, t('tools.music.paused_event'));
			return { ok: true, spoken: t('tools.music.paused') };
		},
	}),

	defineTool({
		name: 'resume_music',
		description: 'Resumes paused music.',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			if (!deps.music.resume()) return { ok: false, spoken: t('tools.music.nothing_to_resume') };
			deps.log?.(t('tools.music.log_resumed'));
			musicEvent(deps, t('tools.music.resumed_event'));
			return { ok: true, spoken: t('tools.music.resumed') };
		},
	}),

	defineTool({
		name: 'skip_music',
		description: 'Skips the current track and moves on to the next one.',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const skipped = deps.music.skip();
			if (!skipped) return { ok: false, spoken: t('tools.music.nothing_to_skip') };
			const next = deps.music.current;
			musicEvent(
				deps,
				next
					? t('tools.music.skipped_event_next', { title: skipped.title, next: next.title })
					: t('tools.music.skipped_event', { title: skipped.title }),
			);
			return {
				ok: true,
				spoken: next ? t('tools.music.skipped_to', { title: next.title }) : t('tools.music.skipped_empty'),
				data: { skipped: skipped.title, now: next?.title ?? null },
			};
		},
	}),

	defineTool({
		name: 'set_music_volume',
		description: 'Sets the music volume (0-100 percent). For "turn it down" go below the current value, for "turn it up" go above it.',
		parameters: P.obj({ percent: P.int('Volume in percent (0-100)') }, ['percent']),
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const percent = Math.max(0, Math.min(100, Math.round(Number(args.percent))));
			if (!Number.isFinite(percent)) return { ok: false, spoken: t('tools.music.bad_volume') };
			const current = deps.music.state?.()?.volume;
			const before = Number.isFinite(current) ? Math.round(current * 100) : null;
			deps.music.setVolume(percent / 100);
			// Show it in the console: the player itself does not log volume changes, so this is what
			// makes a claim like "I turned it up" verifiable.
			deps.log?.(before === null ? t('tools.music.log_volume', { percent }) : t('tools.music.log_volume_change', { before, percent }));
			musicEvent(
				deps,
				before === null ? t('tools.music.volume_event', { percent }) : t('tools.music.volume_event_change', { before, percent }),
				{ previous: before, current: percent },
			);
			const spoken =
				before === null
					? t('tools.music.volume_set', { percent })
					: before === percent
						? t('tools.music.volume_same', { percent })
						: t('tools.music.volume_changed', { before, percent });
			return { ok: true, spoken, data: { percent, before } };
		},
	}),

	defineTool({
		name: 'music_status',
		description:
			'What is playing and how far into it (elapsed / length), what is in the queue and at which positions, the repeat mode and the volume.',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const state = deps.music.state();
			return { ok: true, spoken: deps.music.nowPlayingText(), data: state };
		},
	}),

	defineTool({
		name: 'remove_from_queue',
		description: 'Removes a track from the queue (by queue position or title).',
		parameters: P.obj({ position: P.int('Queue position (1 = next up)'), title: P.str('Track title (partial)') }),
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const key = Number.isInteger(args.position) ? args.position : String(args.title ?? '');
			const removed = deps.music.remove(key);
			if (!removed) return { ok: false, spoken: t('tools.music.queue_not_found') };
			musicEvent(deps, t('tools.music.removed_event', { title: removed.title }));
			return { ok: true, spoken: t('tools.music.removed', { title: removed.title }), data: { title: removed.title } };
		},
	}),

	defineTool({
		name: 'move_in_queue',
		description:
			'Moves a waiting track to another place in the queue by position ("move 3 to 1" = track 3 plays next). ' +
			'Positions are the ones music_status lists (1 = next up); a target past the end moves it to the end.',
		parameters: P.obj(
			{ from: P.int('Queue position of the track to move (1 = next up)'), to: P.int('Its new position (1 = next up)') },
			['from', 'to'],
		),
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const moved = deps.music.move(Math.round(Number(args.from)), Math.round(Number(args.to)));
			if (!moved) return { ok: false, spoken: t('tools.music.queue_not_found') };
			musicEvent(deps, t('tools.music.moved_event', { title: moved.track.title, from: moved.from, position: moved.to }));
			return {
				ok: true,
				spoken: t('tools.music.moved', { title: moved.track.title, position: moved.to }),
				data: { title: moved.track.title, from: moved.from, to: moved.to },
			};
		},
	}),

	defineTool({
		name: 'clear_queue',
		description: 'Empties the queue of waiting tracks. The track playing now keeps playing (stop_music stops everything).',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const title = deps.music.current?.title ?? null;
			const count = deps.music.clear();
			if (!count) return { ok: true, spoken: t('tools.music.cleared_empty'), data: { cleared: 0 } };
			musicEvent(deps, t('tools.music.cleared_event', { count }));
			return {
				ok: true,
				spoken: title ? t('tools.music.cleared', { count, title }) : t('tools.music.cleared_idle', { count }),
				data: { cleared: count, playing: title },
			};
		},
	}),

	defineTool({
		name: 'shuffle_queue',
		description: 'Shuffles the order of the waiting tracks. The track playing now is not touched.',
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const count = deps.music.shuffle();
			if (count < 2) return { ok: false, spoken: t('tools.music.shuffle_too_short') };
			const next = deps.music.queue[0]?.title ?? '';
			musicEvent(deps, t('tools.music.shuffled_event', { count }));
			return { ok: true, spoken: t('tools.music.shuffled', { count, next }), data: { count, next } };
		},
	}),

	defineTool({
		name: 'loop_music',
		description:
			'Repeat mode: "track" repeats the current track ("loop this song"), "queue" starts the queue over when it ends ' +
			'("repeat the queue"), "off" stops repeating. Skipping still moves on while a track is on repeat.',
		parameters: P.obj({ mode: { type: 'string', enum: [...LOOP_MODES], description: 'off / track / queue' } }, ['mode']),
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const mode = String(args.mode ?? '').trim().toLowerCase();
			if (!LOOP_MODES.includes(mode)) return { ok: false, spoken: t('tools.music.bad_loop') };
			// Repeating "this track" with no track is a request about nothing; the other two are settings.
			if (mode === 'track' && !deps.music.current) return nothingPlaying();
			deps.music.setLoop(mode);
			const title = deps.music.current?.title ?? '';
			const event = mode === 'track' ? 'tools.music.loop_event_track' : mode === 'queue' ? 'tools.music.loop_event_queue' : 'tools.music.loop_event_off';
			musicEvent(deps, t(event, { title }), { mode });
			const spoken = mode === 'track' ? t('tools.music.loop_track', { title }) : mode === 'queue' ? t('tools.music.loop_queue') : t('tools.music.loop_off');
			return { ok: true, spoken, data: { mode } };
		},
	}),

	defineTool({
		name: 'seek_music',
		description:
			'Jumps within the current track. "to" is a place: "1:30", "90" (seconds) or "0" for the start ("go to 1:30", "start the song over"); ' +
			'"+30" / "-10" in "to", or "by" in seconds, is a step from where it is now ("skip ahead 30 seconds", "rewind 10 seconds"). ' +
			'A link with no known length (a live stream) can only be started over.',
		parameters: P.obj({
			to: P.str('Where to go: "1:30", "90", "0" for the start, or a step such as "+30" / "-10"'),
			by: P.int('Seconds from the current position: positive = ahead, negative = back'),
		}),
		async handler(args, deps) {
			if (!deps.music) return noMusic();
			const music = deps.music;
			if (!music.current) return nothingPlaying();
			const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
			const target = given(args.to)
				? parseSeekTarget(args.to)
				: given(args.by) && Number.isFinite(Number(args.by))
					? { by: Math.round(Number(args.by)) }
					: null;
			// A model can send any number at all. One that is no place in any track (1e308 reached ffmpeg as
			// "-ss Infinity") is answered here, in words, before the player is asked.
			const amount = target ? ('by' in target ? target.by : target.to) : null;
			if (!target || !Number.isFinite(amount) || Math.abs(amount) > MAX_SEEK_SECONDS) return { ok: false, spoken: t('tools.music.bad_seek') };
			const title = music.current.title;
			let result;
			try {
				result = 'by' in target ? music.seekBy(target.by) : music.seek(target.to);
			} catch (err) {
				if (err.message === SEEK_PAST_END) {
					return { ok: false, spoken: t('tools.music.seek_past_end', { title, duration: formatClock(music.current.duration) }) };
				}
				if (err.message === SEEK_UNSUPPORTED) return { ok: false, spoken: t('tools.music.seek_live', { title }) };
				if (err.message === SEEK_OUT_OF_RANGE) return { ok: false, spoken: t('tools.music.bad_seek') };
				throw err;
			}
			if (!result) return nothingPlaying();
			const position = formatClock(result.to);
			musicEvent(deps, t('tools.music.seek_event', { title, position }), { from: Math.floor(result.from), to: Math.floor(result.to) });
			return {
				ok: true,
				spoken: music.paused ? t('tools.music.seeked_paused', { title, position }) : t('tools.music.seeked', { title, position }),
				data: { title, position: Math.floor(result.to), from: Math.floor(result.from), duration: music.current.duration ?? null },
			};
		},
	}),

	defineTool({
		name: 'save_track',
		description:
			"Keeps a track in this person's own saved list, to be played again by name later. Without an argument it saves " +
			'what is playing now; with a query it looks the track up first.',
		parameters: P.obj({ query: P.str('Song title (+ artist) or URL; empty = what is playing now') }),
		async handler(args, deps) {
			if (!deps.savedTracks) return { ok: false, spoken: t('tools.music.save_disabled') };
			if (!deps.music) return noMusic();
			const speaker = speakerOf(deps);
			if (!speaker.id) return { ok: false, spoken: t('tools.music.save_no_speaker') };
			const query = String(args.query ?? '').trim();
			let track = null;
			try {
				track = query ? await deps.music.resolve(query) : deps.music.current;
			} catch (err) {
				return playFailure(err, deps);
			}
			if (!track) return { ok: false, spoken: t('tools.music.save_nothing_playing') };
			const saved = deps.savedTracks.add({
				userId: speaker.id,
				userName: speaker.name,
				title: track.title,
				// What plays it again: a local file is found by the words that found it (the player matches
				// names inside MUSIC_DIR, not paths), a link or a search by its URL.
				ref: track.kind === 'file' ? (track.query ?? track.title) : (track.url ?? track.title),
				kind: track.kind,
			});
			if (!saved) return { ok: false, spoken: t('tools.music.save_full', { max: MAX_SAVED_PER_USER }) };
			if (saved.duplicate) {
				return { ok: true, spoken: t('tools.music.saved_already', { title: saved.title }), data: { id: saved.id, duplicate: true } };
			}
			await deps.savedTracks.save();
			musicEvent(deps, t('tools.music.saved_event', { title: saved.title }), { source: saved.kind });
			return { ok: true, spoken: t('tools.music.saved', { title: saved.title }), data: { id: saved.id, title: saved.title } };
		},
	}),

	defineTool({
		name: 'list_saved',
		description: 'Lists the tracks this person has saved.',
		async handler(args, deps) {
			if (!deps.savedTracks) return { ok: false, spoken: t('tools.music.save_disabled') };
			const items = deps.savedTracks.list(speakerOf(deps).id);
			if (!items.length) return { ok: true, spoken: t('tools.music.saved_empty'), data: { items: [] } };
			const lines = items.map((item, index) => `${index + 1}. ${item.title}`).join(', ');
			return {
				ok: true,
				spoken: t('tools.music.saved_list', { count: items.length, lines }),
				data: { items: items.map((item, index) => ({ index: index + 1, id: item.id, title: item.title })) },
			};
		},
	}),

	defineTool({
		name: 'remove_saved',
		description: "Takes a track out of this person's saved list: its number in the list, or a few words from its title.",
		parameters: P.obj({ query: P.str('Number in the list, or words from the title') }, ['query']),
		async handler(args, deps) {
			if (!deps.savedTracks) return { ok: false, spoken: t('tools.music.save_disabled') };
			const speaker = speakerOf(deps);
			const needle = String(args.query ?? '').trim();
			const wanted = needle ? pickSaved(deps.savedTracks.list(speaker.id), needle) : null;
			if (!wanted) {
				return { ok: false, spoken: needle ? t('tools.music.saved_not_found', { text: needle }) : t('tools.music.saved_which') };
			}
			deps.savedTracks.remove(speaker.id, wanted.id);
			await deps.savedTracks.save();
			musicEvent(deps, t('tools.music.saved_removed_event', { title: wanted.title }));
			return { ok: true, spoken: t('tools.music.saved_removed', { title: wanted.title }), data: { id: wanted.id } };
		},
	}),

	defineTool({
		name: 'play_saved',
		description: 'Plays what this person saved: one track (its number in the list, or words from its title) or the whole list.',
		parameters: P.obj({ query: P.str('Number in the list, or words from a title'), all: P.bool('true = the whole saved list') }),
		async handler(args, deps) {
			if (!deps.savedTracks) return { ok: false, spoken: t('tools.music.save_disabled') };
			if (!deps.music) return noMusic();
			const speaker = speakerOf(deps);
			const items = deps.savedTracks.list(speaker.id);
			if (!items.length) return { ok: true, spoken: t('tools.music.saved_empty'), data: { queued: 0 } };
			const needle = String(args.query ?? '').trim();
			const wanted = args.all === true || !needle ? items : [pickSaved(items, needle)].filter(Boolean);
			if (!wanted.length) return { ok: false, spoken: t('tools.music.saved_not_found', { text: needle }) };
			let queued = 0;
			let failed = 0;
			let lastError = null;
			for (const item of wanted) {
				try {
					await deps.music.enqueue(item.ref, { requestedBy: speaker.name });
					queued += 1;
				} catch (err) {
					lastError = err;
					// A full queue is a stop, not a reason to keep asking: nothing else will fit either.
					if (err.message === QUEUE_FULL) break;
					failed += 1;
				}
			}
			if (!queued) {
				return lastError?.message === QUEUE_FULL ? playFailure(lastError, deps) : { ok: false, spoken: t('tools.music.saved_none_played') };
			}
			const spoken =
				wanted.length === 1 && queued === 1
					? t('tools.music.saved_playing', { title: wanted[0].title })
					: failed
						? t('tools.music.saved_partial', { count: queued, failed })
						: t('tools.music.saved_queued', { count: queued });
			return { ok: true, spoken, data: { queued, failed, titles: wanted.map((item) => item.title) } };
		},
	}),
];
