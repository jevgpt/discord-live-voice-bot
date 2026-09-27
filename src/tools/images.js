// Image tools: what the bot draws. The picture comes from the OpenAI images API and is posted to a
// text channel as an attachment; the link Discord hands back is a Discord CDN link, which is exactly
// what set_bot_appearance takes — so "make that your avatar" works on the picture it has just posted.

import { AttachmentBuilder } from 'discord.js';
import { t } from '../i18n/index.js';
import { SlidingLimiter, askAfterUntrustedRead, resolveTextChannel } from './helpers.js';
import { P, defineTool } from './registry.js';

// A picture costs money every time it is drawn, so one person cannot turn a conversation into a bill.
const limiter = new SlidingLimiter();
const PER_MINUTE = 3;
export const resetImageLimiter = () => limiter.reset();

const MAX_PROMPT = 1000;

/** b64_json (gpt-image-1) or url (the dall-e models) -> bytes, or null. */
async function imageBytes(entry) {
	if (entry?.b64_json) return Buffer.from(String(entry.b64_json), 'base64');
	if (entry?.url) {
		const response = await fetch(String(entry.url));
		if (!response.ok) return null;
		return Buffer.from(await response.arrayBuffer());
	}
	return null;
}

export const tools = [
	defineTool({
		name: 'generate_image',
		description:
			'Draws a picture from a description and posts it in a text channel as an attachment. That message carries a ' +
			'Discord link to the picture, so the owner can follow up with set_bot_appearance (avatar, banner) if they want it ' +
			'as the bot\'s face.',
		parameters: P.obj(
			{
				prompt: P.str('What to draw'),
				channel: P.str('Channel name to post it in; empty = the default channel'),
				caption: P.str('Text to go with the picture'),
			},
			['prompt'],
		),
		// It posts in the bot's name, caption and all: after other people's words were read in the same
		// turn it waits for the owner's yes, as send_message does (askAfterUntrustedRead).
		asks: true,
		async handler(args, deps, { name }) {
			const prompt = String(args.prompt ?? '').trim().slice(0, MAX_PROMPT);
			if (!prompt) return { ok: false, spoken: t('tools.images.empty') };
			const images = deps.openai?.images ?? null;
			if (!images?.generate) return { ok: false, spoken: t('tools.images.disabled') };
			// Asked before the picture is drawn: drawing it costs money whether or not it is posted.
			const asked = askAfterUntrustedRead(deps, name);
			if (asked) return asked;
			const speaker = deps.currentSpeakerId?.() ?? null;
			if (!limiter.take(`image:${speaker ?? 'anyone'}`, PER_MINUTE)) {
				return { ok: false, spoken: t('tools.images.too_many') };
			}
			const channel = resolveTextChannel(deps, args.channel ? String(args.channel) : null);
			if (!channel) return { ok: false, spoken: t('tools.images.no_channel') };
			let entry = null;
			try {
				const response = await images.generate({
					model: deps.cfg?.imageModel ?? 'gpt-image-1',
					prompt,
					size: deps.cfg?.imageSize ?? '1024x1024',
					n: 1,
				});
				entry = response?.data?.[0] ?? null;
			} catch (err) {
				deps.log?.(t('tools.images.log_failed', { error: err.message }));
				return { ok: false, spoken: t('tools.images.failed') };
			}
			let buffer = null;
			try {
				buffer = await imageBytes(entry);
			} catch {
				buffer = null;
			}
			if (!buffer?.length) return { ok: false, spoken: t('tools.images.failed') };
			try {
				const caption = String(args.caption ?? '').trim().slice(0, 1800);
				const message = await channel.send({
					...(caption ? { content: caption } : {}),
					files: [new AttachmentBuilder(buffer, { name: 'image.png', description: prompt.slice(0, 200) })],
					// A caption is somebody's words and must not ping anybody by accident.
					allowedMentions: { parse: [] },
				});
				const url = message.attachments?.first?.()?.url ?? null;
				deps.log?.(t('tools.images.log_posted', { channel: channel.name }));
				return {
					ok: true,
					spoken: t('tools.images.posted', { channel: channel.name }),
					data: { channel: `#${channel.name}`, url, prompt },
				};
			} catch (err) {
				deps.log?.(t('tools.images.log_failed', { error: err.message }));
				return { ok: false, spoken: t('tools.images.send_failed') };
			}
		},
	}),
];
