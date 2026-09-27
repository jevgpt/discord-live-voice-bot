// Locale bundle: en. Each namespace mirrors a source module group.
import boot from './boot.js';
import runtime from './runtime.js';
import voice from './voice.js';
import live from './live.js';
import brain from './brain.js';
import music from './music.js';
import messages from './messages.js';
import panel from './panel.js';
import commands from './commands.js';
import store from './store.js';
import memory from './memory.js';
import quota from './quota.js';
import summary from './summary.js';
import auth from './auth.js';
import provider from './provider.js';
import agent from './agent.js';
import config from './config.js';
import reader from './reader.js';
import keywords from './keywords.js';
import grammar from './grammar.js';
import speech from './speech.js';
import toolsHelpers from './tools-helpers.js';
import toolsMessaging from './tools-messaging.js';
import toolsMembers from './tools-members.js';
import toolsModeration from './tools-moderation.js';
import toolsChannels from './tools-channels.js';
import toolsRoles from './tools-roles.js';
import toolsSession from './tools-session.js';
import toolsMusic from './tools-music.js';
import toolsMemory from './tools-memory.js';
import toolsSummary from './tools-summary.js';
import toolsThreads from './tools-threads.js';
import toolsReactions from './tools-reactions.js';
import toolsExpressions from './tools-expressions.js';
import toolsEvents from './tools-events.js';
import toolsAutomod from './tools-automod.js';
import toolsWebhooks from './tools-webhooks.js';
import toolsServer from './tools-server.js';
import toolsIdentity from './tools-identity.js';
import toolsImages from './tools-images.js';
import toolsVideos from './tools-videos.js';
import toolsReminders from './tools-reminders.js';

export default {
	boot,
	runtime,
	voice,
	live,
	brain,
	music,
	messages,
	panel,
	commands,
	store,
	memory,
	quota,
	summary,
	auth,
	provider,
	agent,
	config,
	reader,
	keywords,
	grammar,
	speech,
	tools: {
		helpers: toolsHelpers,
		messaging: toolsMessaging,
		members: toolsMembers,
		moderation: toolsModeration,
		channels: toolsChannels,
		roles: toolsRoles,
		session: toolsSession,
		music: toolsMusic,
		memory: toolsMemory,
		summary: toolsSummary,
		identity: toolsIdentity,
		images: toolsImages,
		videos: toolsVideos,
		reminders: toolsReminders,
		server: toolsServer,
		webhooks: toolsWebhooks,
		automod: toolsAutomod,
		events: toolsEvents,
		expressions: toolsExpressions,
		reactions: toolsReactions,
		threads: toolsThreads,
	},
};
