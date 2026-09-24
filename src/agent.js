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
};

/** Command -> tool name and arguments. */
export function toolCallFor(command, deps) {
	if (!command) return null;
	if (command.type === 'music') {
		const name = MUSIC_TOOLS[command.action];
		if (!name) return null;
		const args = {};
		if (command.action === 'play') args.query = command.query;
		if (command.action === 'volume') args.percent = command.percent;
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

/** Runs the command; returns { speak, text, ok } (speak=false means the model should stay quiet). */
export async function executeAction(command, deps) {
	const { recentActions } = deps;
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
			const result = await executeAction(route.command, deps);
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
