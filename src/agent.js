// Delegation (task) layer: the work that runs when GPT-Live asks for help.
//
// Flow (client delegation):
//   1. The model decides that a Discord action / some research is needed -> session.delegation.created
//   2. This module pulls the task out of the last thing the user said and runs it
//   3. The result goes back to the model as session.commentary.append (spoken) with the same delegation_id
//
// The same request can arrive both through the voice-command path and through a delegation, so the
// RecentActions signature cache keeps it from running twice (only SUCCESSFUL results are remembered).

import { t } from './i18n/index.js';
import { actionSignature, RecentActions, routeDelegation } from './commands.js';
import { providerFromDeps } from './provider.js';
import { callTool } from './tools.js';

const TOOL_FOR_COMMAND = {
	send: 'send_message',
	read: 'read_messages',
	join: 'join_voice',
	leave: 'leave_voice',
	character: 'switch_character',
	quiet: 'set_setting',
	music: null, // picked from the action field
};

const MUSIC_TOOLS = {
	play: 'play_music',
	stop: 'stop_music',
	pause: 'pause_music',
	resume: 'resume_music',
	skip: 'skip_music',
	volume: 'set_music_volume',
	status: 'music_status',
	loop: 'loop_music',
	shuffle: 'shuffle_queue',
	clear: 'clear_queue',
	move: 'move_in_queue',
	remove: 'remove_from_queue',
	seek: 'seek_music',
};

/**
 * "Turn the music down" carries a step, not a level, and set_music_volume takes a level: the step is
 * applied to the volume the player has now. Handing the tool the missing percent made it answer that it
 * could not work out the volume, every time.
 */
function steppedVolume(delta, deps) {
	const now = Number(deps?.music?.volume);
	if (!Number.isFinite(now) || !Number.isFinite(delta)) return undefined;
	return Math.max(0, Math.min(100, Math.round(now * 100 + delta)));
}

/** Command -> tool name and arguments. */
export function toolCallFor(command, deps) {
	if (!command) return null;
	if (command.type === 'music') {
		const name = command.action === 'play' && command.next ? 'play_next' : MUSIC_TOOLS[command.action];
		if (!name) return null;
		const args = {};
		if (command.action === 'play') args.query = command.query;
		if (command.action === 'volume') args.percent = command.percent ?? steppedVolume(command.delta, deps);
		if (command.action === 'loop') args.mode = command.mode;
		if (command.action === 'move') Object.assign(args, { from: command.from, to: command.to });
		if (command.action === 'remove') args.position = command.position;
		if (command.action === 'seek') {
			if (command.by !== undefined) args.by = command.by;
			else args.to = command.to;
		}
		return { name, args };
	}
	const name = TOOL_FOR_COMMAND[command.type];
	if (!name) return null;
	const channelName = command.channel?.name ?? command.name ?? null;
	const args =
		command.type === 'send'
			? { channel: channelName, text: command.text, mentions: command.mentions ?? [] }
			: command.type === 'read'
				? { channel: channelName, count: command.count ?? deps?.cfg?.readLimit }
				: command.type === 'join'
					? { channel: channelName }
					: command.type === 'character'
						? { name: command.character?.name ?? command.name }
						: command.type === 'quiet'
							? { name: 'quiet', value: command.value }
							: {};
	return { name, args };
}

// The music commands that act on what is waiting; every other one but "play" acts on the track playing now.
const QUEUE_ACTIONS = new Set(['shuffle', 'clear', 'move', 'remove']);

/**
 * A music command heard with nothing for it to act on. Those words were matched with no wake word, and
 * with no music at all they are far more likely somebody talking than somebody asking: "stop repeating",
 * "go back ten seconds", "a bit quieter". The bot answered every one of them with "Nothing is playing
 * right now". A request to play is the one that needs no music to be there already.
 */
function actsOnNothing(command, music) {
	if (command?.type !== 'music' || command.action === 'play') return false;
	if (QUEUE_ACTIONS.has(command.action)) return !music?.queue?.length;
	return !music?.current;
}

/**
 * Runs the command; returns { speak, text, ok } (speak=false means the model should stay quiet), or null
 * when there is nothing to run. A command is taken to come from the voice grammar -- matched in what
 * somebody said, no model involved -- unless `delegated` says the model asked for it; only the model is
 * owed an answer when there is no music for a music command to act on.
 */
export async function executeAction(command, deps, { delegated = false } = {}) {
	const { recentActions } = deps;
	if (!delegated && actsOnNothing(command, deps.music)) return null;
	// A read is remembered per person: whether a channel may be read is a question about who asked, and
	// the owner's reading of #staff handed back from the cache to a guest asking half a minute later is
	// #staff read to the guest.
	const base = actionSignature(command);
	const signature = base && command.type === 'read' ? `${base}:${deps.currentSpeakerId?.() ?? '-'}` : base;
	const cached = recentActions?.recall(signature);
	if (cached) return { ...cached, reused: true };

	const call = toolCallFor(command, deps);
	if (!call) return null;

	const result = await callTool(call.name, call.args, deps);
	// Switching character rebuilds the session, so nothing extra is said (unless it failed).
	const speak = command.type !== 'character' || result.ok === false;
	const outcome = { speak, text: result.spoken ?? t('agent.done'), ok: result.ok !== false };
	if (outcome.ok) recentActions?.remember(signature, outcome);
	return outcome;
}

/** Answers questions that need up-to-date information: web_search on OpenAI, plain chat on DeepSeek. */
export async function research(question, deps) {
	const provider = providerFromDeps(deps);
	const { log } = deps;
	if (!provider.available) return t('agent.research_unavailable');
	const canSearch = provider.textApi !== 'chat';
	// The question is wrapped in a tag so the model can tell it from the instructions; the tag itself is
	// stripped out of the user's words first.
	const quoted = `<question>${String(question).replace(/<\/?question>/gu, '')}</question>`;
	const prompt =
		t('agent.research_prompt', { question: quoted }) +
		(canSearch ? t('agent.research_with_search') : t('agent.research_without_search')) +
		t('agent.research_style') +
		t('agent.research_honesty');
	try {
		const text = await provider.research(prompt);
		return text || (canSearch ? t('agent.research_empty') : t('agent.empty_result'));
	} catch (err) {
		log?.(t('agent.log_research_failed', { error: err.message }));
		return t('agent.research_failed');
	}
}

/**
 * Delegation runner: pulls the task out of the last user text and either carries out
 * the local Discord action or does the research.
 *
 * @returns {Promise<{mode: 'commentary'|'thinking'|'none', text: string}>}
 */
export function createTaskRunner(deps) {
	return async function run() {
		const text = deps.getUserText();
		const route = routeDelegation(text ?? '', deps.store.list(), deps.channelLists());
		if (route.kind === 'action') {
			const result = await executeAction(route.command, deps, { delegated: true });
			if (!result) return { mode: 'commentary', text: t('agent.request_unclear') };
			// Switching character rebuilds the session; no answer is sent to the old delegation.
			if (!result.speak && !result.reused) return { mode: 'none', text: '' };
			return { mode: result.reused ? 'thinking' : 'commentary', text: result.text };
		}
		if (!text) return { mode: 'commentary', text: t('agent.intent_unclear') };
		return { mode: 'commentary', text: await research(text, deps) };
	};
}

export { RecentActions };
