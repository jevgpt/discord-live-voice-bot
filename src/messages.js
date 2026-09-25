// Reply layer for written messages: DMs and channel messages where the bot is mentioned.
//
// The voice session (GPT-Live) takes no text input; written replies are therefore produced with the
// text provider (provider.js: DeepSeek or OpenAI), and the persona (character prompt) is handed over as
// the system instruction. While the bot is in a voice channel the reply is also sent to the model as
// "commentary", so the channel hears it too.

import { t, tList } from './i18n/index.js';
import { providerFromDeps } from './provider.js';
import { balanceCodeFences, safeContext, squash } from './text.js';

export { balanceCodeFences };

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REPLY = 1900;

// Images that must not be commented on: sexual content/nudity, minors, graphic violence, threats.
const BLOCKED_CATEGORIES = [
	'sexual',
	'sexual/minors',
	'violence/graphic',
	'harassment/threatening',
	'hate/threatening',
	'self-harm/intent',
	'illicit/violent',
];

// A function instead of a constant: the text is translated, so it is read when it is used.
const VISION_RULES = () => t('messages.vision_rules');

// Per-user rate limit for written replies (DM/mention): at most N per minute.
const REPLY_WINDOW_MS = 60_000;

/** Simple sliding-window counter (per user). */
/**
 * Reply budget, per person and for the process as a whole. Without the process-wide window every member
 * gets their own quota of model calls per minute, and all of them are billed to the owner's key.
 */
export class ReplyLimiter {
	constructor({ perMinute = 6, totalPerMinute = 30, now = Date.now } = {}) {
		this.perMinute = perMinute;
		this.totalPerMinute = totalPerMinute;
		this.now = now;
		this.hits = new Map();
		this.all = [];
	}

	allow(userId) {
		const at = this.now();
		const fresh = (stamps) => stamps.filter((stamp) => at - stamp < REPLY_WINDOW_MS);
		this.all = fresh(this.all);
		if (this.all.length >= this.totalPerMinute) return false;
		const list = fresh(this.hits.get(userId) ?? []);
		if (list.length >= this.perMinute) {
			// Keep the bucket only while it still holds something, so one entry per past sender does not
			// accumulate for the lifetime of the process.
			if (list.length) this.hits.set(userId, list);
			else this.hits.delete(userId);
			return false;
		}
		list.push(at);
		this.hits.set(userId, list);
		this.all.push(at);
		return true;
	}
}

/** Collects the images attached to a message (with a type, size and count limit). */
export function imageAttachments(message, { max = MAX_IMAGES } = {}) {
	const list = [];
	const values = message?.attachments?.values?.();
	if (!values) return list;
	for (const attachment of values) {
		const contentType = String(attachment?.contentType ?? '');
		if (!contentType.startsWith('image/')) continue;
		if (!attachment.url) continue;
		if (Number(attachment.size ?? 0) > MAX_IMAGE_BYTES) continue;
		list.push({
			url: attachment.url,
			name: attachment.name ?? t('messages.attachment_fallback_name'),
			contentType: contentType.split(';')[0].trim(),
		});
		if (list.length >= max) break;
	}
	return list;
}

const ALLOWED_IMAGE_HOSTS = /(?:^|\.)(?:discordapp\.com|discordapp\.net|discord\.com)$/i;

/**
 * Downloads the image ourselves and turns it into a base64 data URL. Discord CDN links are signed and
 * short-lived; instead of trusting OpenAI to fetch them, we carry the bytes. Only Discord domains are
 * downloaded from (the SSRF surface stays closed).
 */
export async function fetchImageAsDataUrl(url, { timeoutMs = 12_000, maxBytes = MAX_IMAGE_BYTES, contentType = null } = {}) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('invalid image address');
	}
	if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) {
		throw new Error('images are only downloaded over the Discord CDN');
	}
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
	if (!response.ok) throw new Error(`image could not be downloaded (${response.status})`);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (!buffer.length) throw new Error('image is empty');
	if (buffer.length > maxBytes) throw new Error('image is too large');
	const header = (response.headers.get('content-type') ?? '').split(';')[0].trim();
	// The type the server reports wins; then the contentType of the Discord attachment; jpeg as a last resort.
	const mime = [header, contentType].find((value) => value && value.startsWith('image/')) ?? 'image/jpeg';
	return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Runs the images through moderation. Returns true when there is content that must not be commented on.
 * It also returns true when moderation itself fails: an image we cannot verify is not commented on (fail-closed).
 */
export async function containsBlockedImage(visionClient, images, log) {
	if (!images.length) return false;
	if (!visionClient?.moderations?.create) {
		log?.(t('messages.log_no_moderation'));
		return true;
	}
	try {
		const response = await visionClient.moderations.create(
			{
				model: 'omni-moderation-latest',
				input: images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl ?? image.url } })),
			},
			{ timeout: 20_000 },
		);
		return (response.results ?? []).some((result) =>
			BLOCKED_CATEGORIES.some((category) => result?.categories?.[category] === true),
		);
	} catch (err) {
		log?.(t('messages.log_moderation_failed', { error: err.message }));
		return true;
	}
}

/**
 * Reports a blocked image to the panel/owner: NO DM IS SENT, an event record is left behind.
 * (User request: the bot must not send DMs on its own, the record should show up in the panel.)
 */
function reportBlockedImage(deps, { authorName, where }) {
	deps.activity?.({
		kind: 'safety',
		direction: 'in',
		whoName: authorName,
		text: t('messages.safety_image_blocked', { where }),
		meta: { type: t('messages.safety_meta_image'), where },
	});
}

/** Should this message be answered? (a DM, a mention, or a reply to one of the bot's messages) */
export function shouldReply(message, { botId, guildId }) {
	if (!message?.author || message.author.bot) return false;
	if (message.author.id === botId) return false;
	const isDm = !message.guild;
	if (isDm) return true;
	if (message.guild.id !== guildId) return false;
	if (message.mentions?.users?.has(botId)) return true;
	if (message.mentions?.repliedUser?.id === botId) return true;
	return false;
}

/**
 * System instruction + input text for a written reply. The user text stays out of the instruction, inside
 * a delimiter. The notes kept about the author are the author's own words as much as anybody's (anyone can
 * have one kept about themselves), so they go in cleaned the way the voice session cleans them (safeContext)
 * and closed off at the end, under the same framing: notes about a person, not instructions.
 */
export function buildReplyPrompt({ personaName, personaPrompt, authorName, channelName, isDm, text, memory = null }) {
	const where = isDm ? t('messages.reply_where_dm') : t('messages.reply_where_channel', { channel: channelName });
	const notes = memory ? safeContext(memory, { keepLines: true }) : '';
	const instructions = [
		personaPrompt ?? '',
		t('messages.reply_intro', { where }),
		...tList('messages.reply_rules'),
		notes ? t('messages.reply_memory', { memory: notes }) : '',
	]
		.filter(Boolean)
		.join(' ');
	return {
		instructions,
		input: t('messages.reply_input', { author: String(authorName).replace(/["<>]/g, ''), text }),
		persona: personaName ?? null,
	};
}

/**
 * Produces the reply text. provider.js picks the provider: text goes to DeepSeek when it is configured,
 * messages that carry images always take the OpenAI (vision) path.
 */
export async function createReplyText(deps, { instructions, input, withImages = false }) {
	const provider = providerFromDeps(deps);
	if (withImages) return provider.completeWithImages({ instructions, input });
	return provider.complete({ instructions, input });
}

/**
 * Produces a reply to the message and sends it; also has the model speak it when in a voice channel.
 * @returns {Promise<string|null>} the reply that was sent, or null
 */
export async function handleMessage(message, deps) {
	const { log } = deps;
	// deps.guildId is the server this message may be answered in: with several servers it is the one the
	// message came from, so a mention outside the primary target is not dropped.
	if (!shouldReply(message, { botId: deps.client?.user?.id ?? null, guildId: deps.guildId ?? deps.cfg.guildId })) return null;

	const isDm = !message.guild;
	if (isDm && !deps.cfg.respondToDms) return null;
	if (!isDm && !deps.cfg.respondToMentions) return null;

	const text = squash(message.content);
	const images = imageAttachments(message);
	if (!text && !images.length) return null;

	const authorId = message.author.id;
	if (deps.replyLimiter && !deps.replyLimiter.allow(authorId)) {
		log?.(t('messages.log_rate_limited', { user: authorId, where: isDm ? 'DM' : t('messages.scope_channel') }));
		return null;
	}

	const persona = deps.persona();
	// The channel people are actually talking to the bot in: "send everyone a hello" with no channel named
	// goes here when no default channel is configured.
	if (!isDm && message.channel?.id) deps.noteTextChannel?.(message.channel.id);
	const authorName = message.member?.displayName ?? message.author.displayName ?? message.author.username ?? t('messages.someone');
	const where = isDm ? 'DM' : `#${message.channel?.name ?? t('messages.channel_fallback')}`;

	// We download the images ourselves and turn them into data URLs; moderation runs after that.
	let prepared = images;
	if (images.length) {
		try {
			prepared = await Promise.all(
				images.map(async (image) => ({ ...image, dataUrl: await fetchImageAsDataUrl(image.url, { contentType: image.contentType }) })),
			);
		} catch (err) {
			log?.(t('messages.log_image_download_failed', { where, user: authorId, error: err.message }));
			await message
				.reply({ content: t('messages.image_download_failed_reply'), allowedMentions: { repliedUser: false } })
				.catch(() => {});
			return null;
		}
		const visionClient = deps.visionClient ?? providerFromDeps(deps).visionClient;
		if (await containsBlockedImage(visionClient, prepared, log)) {
			log?.(t('messages.log_image_blocked', { where, user: authorId }));
			await message
				.reply({ content: t('messages.image_blocked_reply'), allowedMentions: { repliedUser: false } })
				.catch(() => {});
			reportBlockedImage(deps, { authorName, where });
			return null;
		}
	}

	const prompt = buildReplyPrompt({
		personaName: persona.name,
		personaPrompt: persona.prompt,
		authorName,
		channelName: message.channel?.name ?? t('messages.channel_fallback'),
		isDm,
		text,
		memory: deps.memory?.summaryFor?.(authorId) ?? null,
	});

	let reply = null;
	try {
		const withImages = prepared.length > 0;
		const input = withImages
			? [
					{
						role: 'user',
						content: [
							{ type: 'input_text', text: `${authorName}: ${text || t('messages.sent_image')}` },
							...prepared.map((image) => ({ type: 'input_image', image_url: image.dataUrl ?? image.url })),
						],
					},
				]
			: prompt.input;
		const instructions = withImages ? `${prompt.instructions} ${VISION_RULES()}` : prompt.instructions;
		const raw = await createReplyText(deps, { instructions, input, withImages });
		// Line breaks are kept when there is a code block; plain text is squashed onto a single line.
		const trimmed = String(raw ?? '').trim();
		const normalized = trimmed.includes('```') ? trimmed : squash(trimmed);
		reply = balanceCodeFences(normalized, { maxLength: MAX_REPLY }) || null;
	} catch (err) {
		log?.(t('messages.log_reply_failed', { error: err.message }));
	}

	if (!reply) {
		await message
			.reply({ content: t('messages.unavailable_reply'), allowedMentions: { repliedUser: false } })
			.catch(() => {});
		return null;
	}

	try {
		// parse: [] -> expressions like "@everyone" inside the text mention nobody (no accidental pings).
		await message.reply({ content: reply, allowedMentions: { repliedUser: false, parse: [] } });
		log?.(t('messages.log_replied', { where, who: authorName }));
	} catch (err) {
		log?.(t('messages.log_send_failed', { error: err.message }));
		return null;
	}

	// A written reply is only spoken in the voice channel when VOICE_ECHO_TEXT_REPLIES is on and it is a
	// channel message (off by default: writing stays writing, the voice conversation is not interrupted);
	// DM replies are never read out. Reading a reply that contains a code block out loud makes no sense:
	// a short summary is spoken instead.
	const live = deps.getLive?.();
	if (!isDm && deps.cfg?.voiceEchoTextReplies === true && live?.ready) {
		live.appendContext('commentary', reply.includes('```') ? t('messages.code_spoken') : reply);
	}

	return reply;
}
