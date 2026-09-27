// Who is in the room and what they are called: names (the live cache, the member index, memory), the
// label a line is said under, the roster, the speaker announcement that follows the audio the model
// really hears, the memory hint, and the bot's status line.
//
// Writes: sentCandidate, sentCandidateFrames, sentSilentFrames, recentSpeakers, presence, and
// lastSpeakingKey (created on first use, not in the constructor).
// Shared: lastAnnouncedUser -- who the model was last TOLD about -- is set here by announceSpeaker and
// by announceLine (transcript.js), and reset to null by the 'ready' handler (livelink.js) and by
// onVoiceStateUpdate (guildsession.js). memoryHinted is added to here and cleared by the 'ready'
// handler and by enterVoice. memberNameMap is built and dropped here, and dropped by start()'s member
// refresh as well.
// Reads only: cfg, client, guild, voice, live, memory, memberIndex.

import { ActivityType } from 'discord.js';
import { t } from '../i18n/index.js';
import { normalize, safeContext } from '../text.js';
import { SPEAKER_GAP_FRAMES, SPEAKER_STABLE_FRAMES } from './constants.js';

export const speakerMethods = {
	isOwnerId(userId) {
		return Boolean(this.cfg.ownerId && String(userId) === String(this.cfg.ownerId));
	},

	/** How many humans are in the bot's voice channel (for the local brain's "who do I answer" decision). */
	humansInVoice() {
		// peopleInVoice's count -- this was a copy of its loop -- but never below one.
		return Math.max(1, this.peopleInVoice());
	},

	/** How many people (not bots) are in the bot's voice channel right now; 0 when it is in none. */
	peopleInVoice() {
		const channelId = this.voice.channelId;
		if (!channelId || !this.guild) return 0;
		let count = 0;
		for (const state of this.guild.voiceStates.cache.values()) {
			if (state.channelId !== channelId) continue;
			const member = state.member ?? this.guild.members.cache.get(state.id);
			if (!member?.user?.bot) count++;
		}
		return count;
	},

	/**
	 * The people in the bot's voice channel as members: bots are left out, and so is anybody whose member
	 * is not in the cache, because what the callers want is a name. Empty when the bot is in no channel.
	 * peopleInVoice keeps a loop of its own on purpose -- a person nobody can name is still a person to
	 * count -- and so does speakerLabel, which skips the person it is naming and has no channel guard.
	 */
	membersInVoice() {
		const members = [];
		const channelId = this.voice.channelId;
		if (!channelId || !this.guild) return members;
		for (const state of this.guild.voiceStates.cache.values()) {
			if (state.channelId !== channelId) continue;
			const member = state.member ?? this.guild.members.cache.get(state.id);
			if (!member || member.user?.bot) continue;
			members.push(member);
		}
		return members;
	},

	/** Used to show who is speaking in the panel: the live cache first, then the member index. */
	nameFor(userId) {
		if (!userId) return null;
		const cached = this.guild?.members.cache.get(userId)?.displayName;
		if (cached) return cached;
		if (!this.memberNameMap) {
			this.memberNameMap = new Map((this.memberIndex.list?.() ?? []).map((entry) => [entry.id, entry.display]));
		}
		return this.memberNameMap.get(userId) ?? this.memory?.nameFor(userId) ?? `id:${userId}`;
	},

	async memberName(userId) {
		const cached = this.guild?.members.cache.get(userId);
		if (cached) return cached.displayName;
		try {
			const member = await this.guild.members.fetch(userId);
			return member.displayName;
		} catch {
			return this.nameFor(userId);
		}
	},

	/** A member showed up or changed: keep the index fresh; `stale` also drops the cached name map. */
	rememberMember(member, { stale = false } = {}) {
		this.memberIndex.upsert(member);
		if (stale) this.memberNameMap = null;
	},

	/** The member left the server: forget them in the index and in the cached name map. */
	forgetMember(userId) {
		this.memberIndex.remove(userId);
		this.memberNameMap = null;
	},

	/**
	 * The name to tell the model, or to write in the log, when saying who spoke.
	 *
	 * Two people in one channel really can carry the same display name -- seen live, with the owner and
	 * somebody else both showing as the same word. The name then identifies nobody, and every "X said
	 * this" note is a coin toss the model has no way to question. Where that happens the account name
	 * goes with it; everywhere else the name is left alone, because a name plus an account for a room of
	 * strangers reads like a database dump.
	 */
	speakerLabel(userId) {
		const name = this.nameFor(userId);
		if (!name || !this.guild) return name;
		const key = normalize(name);
		if (!key) return name;
		let clash = false;
		for (const state of this.guild.voiceStates.cache.values()) {
			if (state.channelId !== this.voice.channelId) continue;
			if (String(state.id) === String(userId)) continue;
			const member = state.member ?? this.guild.members.cache.get(state.id);
			if (!member || member.user?.bot) continue;
			if (normalize(member.displayName) === key) {
				clash = true;
				break;
			}
		}
		if (!clash) return name;
		const account = this.guild.members.cache.get(String(userId))?.user?.username;
		return account ? t('runtime.name_with_account', { name, account }) : name;
	},

	/** Who is in the voice channel (people, not bots), with the owner marked. */
	rosterNames() {
		return this.membersInVoice().map((member) => ({ name: this.speakerLabel(member.id), owner: this.isOwnerId(member.id) }));
	},

	/** Tells the model who is in the channel (when the session opens and on joins/leaves). */
	announceRoster(prefix = t('runtime.roster_prefix')) {
		if (!this.live?.ready || !this.voice.channelId || !this.guild) return;
		const names = this.rosterNames().map((entry) => `${entry.name}${entry.owner ? t('runtime.owner_suffix') : ''}`);
		if (!names.length) return;
		this.live.appendContext('instructions', t('runtime.roster_context', { prefix, names: safeContext(names.join(', ')) }));
		if (this.cfg.transcripts) this.log(t('runtime.log_context_roster', { names: names.join(', ') }));
	},

	/**
	 * How many different people have been heard in the last `withinMs`. With three or more the channel is
	 * "crowded": a running "now speaking: X" commentary is then both noisy and frequently wrong for any
	 * given sentence, so the transcript lines carry the speaker instead.
	 */
	recentSpeakerCount(withinMs = 20_000) {
		const now = Date.now();
		for (const [id, at] of this.recentSpeakers) {
			if (now - at > withinMs) this.recentSpeakers.delete(id);
		}
		return this.recentSpeakers.size;
	},

	noteRecentSpeaker(userId) {
		if (!userId) return;
		this.recentSpeakers.set(String(userId), Date.now());
		if (this.recentSpeakers.size > 24) this.recentSpeakers.delete(this.recentSpeakers.keys().next().value);
	},

	trackSentSpeaker({ priority, active, sent }) {
		if (!sent || !this.cfg.announceSpeaker) return;
		// Two voices in this frame. announceSpeaker writes to the 'instructions' channel, the one the model
		// treats as hard fact, so naming one of them here is the most expensive version of this bug. An
		// ambiguous frame is neither counted towards a candidate nor treated as silence: the announcement
		// simply waits for the room to settle.
		if (!priority && active.length > 1) return;
		const id = priority ? (this.cfg.ownerId ?? active[0] ?? null) : (active[0] ?? null);
		if (!id) {
			// Discord packets arrive with jitter: if a single empty frame reset the counter, the owner would never be "stable".
			if (++this.sentSilentFrames > SPEAKER_GAP_FRAMES) {
				this.sentCandidate = null;
				this.sentCandidateFrames = 0;
			}
			return;
		}
		this.sentSilentFrames = 0;
		if (String(id) === this.sentCandidate) this.sentCandidateFrames++;
		else {
			this.sentCandidate = String(id);
			this.sentCandidateFrames = 1;
		}
		if (this.sentCandidateFrames === SPEAKER_STABLE_FRAMES) {
			this.noteRecentSpeaker(this.sentCandidate);
			// `lastAnnouncedUser` means "this is who the model was TOLD about", so it must not be set here
			// when the announcement is skipped: onTranscript compares against it to decide whether a line
			// still needs a label, and a silent update would leave a whole conversation unattributed once
			// the channel quietened down again.
			if (this.sentCandidate !== this.lastAnnouncedUser && this.recentSpeakerCount() < 3) {
				void this.announceSpeaker(this.sentCandidate);
			}
		}
	},

	/** Tells the model who is speaking: name, whether they are the owner, and (the first time) memory notes.
	 * It is not repeated while the same person keeps talking. */
	async announceSpeaker(userId) {
		if (!this.live?.ready || this.lastAnnouncedUser === userId) return;
		this.lastAnnouncedUser = userId;
		await this.memberName(userId); // makes sure the member is in the cache before the name is read
		const name = safeContext(this.speakerLabel(userId));
		const owner = this.isOwnerId(userId);
		// An "instructions" note: the model takes it as hard fact ("thinking" notes are too weak in conversation).
		this.live.appendContext(
			'instructions',
			t('runtime.speaker_context', {
				name,
				ownerNote: owner ? t('runtime.speaker_context_owner') : '',
				ownerAnswer: owner ? t('runtime.speaker_context_owner_answer') : '',
			}),
		);
		// The notes go on "thinking", as hintMemory sends them, and never on "instructions": anybody can
		// have a note kept about themselves in words of their choosing, and the channel the model treats as
		// hard fact is no place for them, however they are framed.
		if (this.memory && !this.memoryHinted.has(userId)) {
			const summary = this.memory.summaryFor(userId);
			if (summary) {
				this.memoryHinted.add(userId);
				this.live.appendContext('thinking', t('runtime.memory_notes', { name, summary: safeContext(summary, { keepLines: true }) }));
			}
		}
		if (this.cfg.transcripts) this.log(t('runtime.log_context_speaker', { name, owner: owner ? t('runtime.owner_tag') : '' }));
	},

	/** If memory holds notes about the speaker, tell the model once, quietly (even when announce is off). */
	async hintMemory(userId) {
		if (!this.memory || !this.live?.ready || this.memoryHinted.has(userId)) return;
		const summary = this.memory.summaryFor(userId);
		if (!summary) return;
		this.memoryHinted.add(userId);
		// The same cleaning as announceSpeaker: a display name or a note must not be able to start a new line
		// of its own that reads like part of the frame around it.
		const name = safeContext(await this.memberName(userId));
		// The name may have come from Discord; the session can have closed while it did.
		this.live?.appendContext('thinking', t('runtime.memory_notes', { name, summary: safeContext(summary, { keepLines: true }) }));
	},

	/**
	 * Debug line: who the audio says is speaking right now, by NAME. It used to live in the bridge, which
	 * has no way to resolve an id, so it printed raw numeric ids many times a second. De-duplicated on the
	 * set of ids so it only prints when the set changes.
	 */
	logSpeaking(active) {
		const ids = Array.isArray(active) ? active.map((id) => String(id)) : [];
		const key = ids.join(',');
		if (key === this.lastSpeakingKey) return;
		this.lastSpeakingKey = key;
		if (!ids.length) return;
		this.log(t('voice.speaking', { ids: ids.map((id) => this.speakerLabel(id)).join(', ') }));
	},

	/** Remembers the status line to go back to once the music stops. */
	setDefaultPresence(presence) {
		this.presence = presence ?? null;
	},

	/**
	 * Puts the playing track under the bot's name, and returns to whatever the status line was when the
	 * music stops. Presence belongs to the account, not to a guild, so with several servers the most
	 * recent track wins; that is also what a person watching the bot's profile would expect.
	 */
	showPresence(track = null) {
		const user = this.client?.user;
		if (!user?.setPresence || this.cfg.presenceMusic === false) return;
		try {
			if (track?.title) {
				user.setPresence({ activities: [{ name: t('tools.identity.now_playing', { title: String(track.title).slice(0, 128) }), type: ActivityType.Listening }], status: this.presence?.status ?? 'online' });
				return;
			}
			const back = this.presence;
			user.setPresence({ activities: back?.text ? [{ name: back.text, type: back.type ?? ActivityType.Playing }] : [], status: back?.status ?? 'online' });
		} catch {
			/* presence is cosmetic: never let it break the session */
		}
	},
};
