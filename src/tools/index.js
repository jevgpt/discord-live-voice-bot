// Tool registry: pulls all the domain modules together, hands the schemas to the model and routes
// calls through the gate (owner check) to the handler.

import { tools as channelTools } from './channels.js';
import { tools as memberTools } from './members.js';
import { tools as memoryTools } from './memory.js';
import { tools as messagingTools } from './messaging.js';
import { tools as moderationTools } from './moderation.js';
import { tools as musicTools } from './music.js';
import { tools as roleTools } from './roles.js';
import { tools as sessionTools } from './session.js';
import { tools as summaryTools } from './summary.js';
import { tools as threadsTools } from './threads.js';
import { tools as reactionsTools } from './reactions.js';
import { tools as reminderTools } from './reminders.js';
import { tools as expressionsTools } from './expressions.js';
import { tools as eventsTools } from './events.js';
import { tools as automodTools } from './automod.js';
import { tools as webhooksTools } from './webhooks.js';
import { tools as serverTools } from './server.js';
import { tools as videoTools } from './video.js';
import { tools as identityTools } from './identity.js';
import { tools as imageTools } from './images.js';
import { needsCallContext, noteActionWords, noteUntrustedRead, ownerGate, settleSpokenAnswer } from './helpers.js';
import { t } from '../i18n/index.js';

// Tools whose output is other people's words: what was written in a channel (read_messages goes through
// the channel reader, list_pins shows the pinned messages), what a video says, the notes people left,
// and summaries of what was said. Any of it can be phrased as an order, and the model reads it in the
// middle of a request. Their output goes back as quoted material under a notice that says so (see
// toolOutput), and once one of them has run in a turn, every owner-only tool in the rest of that turn
// asks the owner out loud first (see untrustedGate in helpers.js), and so does posting anything in the
// bot's name and reading what @everyone cannot (askAfterUntrustedRead). Kept in one list rather than on each
// definition so the whole set can be read in one place; a name here that no module defines stops the
// start-up below, so a renamed tool cannot silently lose the flag.
const UNTRUSTED_OUTPUT = new Set([
	'read_messages',
	'list_pins',
	'recall_notes',
	'watch_video',
	'video_transcript',
	'summarize_video',
	'summarize_conversation',
]);

const REGISTRY = new Map();
for (const list of [
	messagingTools,
	sessionTools,
	memberTools,
	moderationTools,
	channelTools,
	roleTools,
	musicTools,
	memoryTools,
	summaryTools,
	identityTools,
	imageTools,
	serverTools,
	videoTools,
	webhooksTools,
	automodTools,
	eventsTools,
	expressionsTools,
	reactionsTools,
	reminderTools,
	threadsTools,
]) {
	for (const tool of list) {
		if (REGISTRY.has(tool.name)) throw new Error(`tool defined twice: ${tool.name}`);
		REGISTRY.set(tool.name, tool);
		// The owner's answer to a question about this tool is read knowing its command words: "yes, cancel
		// it" is a yes to cancelling an event and a no to anything else (see readAnswer).
		if (tool.gate?.keywords) noteActionWords(tool.name, tool.gate.keywords);
	}
}
for (const name of UNTRUSTED_OUTPUT) {
	if (!REGISTRY.has(name)) throw new Error(`untrusted-output flag on a tool that does not exist: ${name}`);
}

/** The function-calling schemas handed to the model. */
export function toolDefinitions() {
	return [...REGISTRY.values()].map((tool) => tool.definition);
}

/** Tool name -> { gated, asks, keywords, untrusted } (for tests/documentation). */
export function toolMeta() {
	return [...REGISTRY.values()].map((tool) => ({
		name: tool.name,
		gated: Boolean(tool.gate),
		asks: Boolean(tool.asks),
		keywords: tool.gate?.keywords ?? null,
		untrusted: UNTRUSTED_OUTPUT.has(tool.name),
	}));
}

export function hasTool(name) {
	return REGISTRY.has(name);
}

/** What a tool does, as the model is told it; the gate hands this to Jev. */
export function toolDescription(name) {
	return REGISTRY.get(name)?.definition?.description ?? null;
}

/**
 * Runs the tool.
 * @returns {Promise<{ ok: boolean, spoken: string, data?: object, warnings?: string[], needs_confirmation?: boolean }>}
 *   spoken: the short result text the model says out loud.
 */
export async function callTool(name, args = {}, deps) {
	const tool = REGISTRY.get(name);
	if (!tool) return { ok: false, spoken: t('tools.helpers.unknown_tool', { name }) };
	const input = args ?? {};
	// The rule about other people's words has to know which call it is judging (its arguments, and
	// whether the owner has already said yes to it in this call), so such a call gets a deps of its own.
	// The realtime path copies deps for every call already; everything else passes through untouched.
	const callDeps = needsCallContext(deps, name) ? { ...deps, toolCall: { name, args: input, confirmed: false } } : deps;
	if (input.confirm === true) await settleSpokenAnswer(callDeps, name);
	if (tool.gate) {
		const denied = await ownerGate(callDeps, tool.gate.keywords ?? null, name);
		if (denied) return denied;
	}
	let result;
	try {
		result = await tool.handler(input, callDeps, { name });
	} catch (err) {
		deps?.log?.(t('tools.helpers.log_tool_error', { name, error: String(err?.stack ?? err) }));
		result = { ok: false, spoken: t('tools.helpers.tool_error', { name, error: String(err?.message ?? err) }) };
	}
	if (!UNTRUSTED_OUTPUT.has(name)) return result;
	// Marked whatever the outcome: a failure can still carry what the far end said.
	if (callDeps) noteUntrustedRead(callDeps, name);
	return { ...result, untrusted: true };
}

/**
 * Turns a tool result into the function_call_output text sent back to the Responses backend (and to the
 * local brain). Other people's words (result.untrusted) go under "quoted", after a notice saying what
 * they are, so the model can tell material it is reporting from a request it has been given.
 */
export function toolOutput(result) {
	const status = {
		...(result?.needs_confirmation ? { needs_confirmation: true } : {}),
		...(result?.denied ? { denied: true } : {}),
		...(result?.error ? { error: result.error } : {}),
	};
	const content = {
		...(result?.data ? { data: result.data } : {}),
		...(result?.warnings?.length ? { warnings: result.warnings } : {}),
	};
	if (result?.untrusted) {
		return JSON.stringify({
			ok: Boolean(result?.ok),
			notice: t('tools.helpers.untrusted_notice'),
			quoted: { summary: result?.spoken ?? '', ...content },
			...status,
		});
	}
	return JSON.stringify({ ok: Boolean(result?.ok), summary: result?.spoken ?? '', ...status, ...content });
}
