// Strings for src/provider.js (en). Referenced as "provider.<key>".
export default {
	text_provider_missing: 'the text provider is not configured',
	vision_client_missing: 'there is no OpenAI client for interpreting images',
	research_provider_missing: 'the research provider is not configured',
	describe_deepseek: 'DeepSeek ({textModel}) — DM/channel replies and research; images go to OpenAI ({visionModel})',
	describe_openai: 'OpenAI ({textModel})',
	reply_key_missing: '[text] REPLY_BASE_URL is set for REPLY_MODEL={model} but REPLY_API_KEY is empty; written replies stay on {fallback} for now',
};
