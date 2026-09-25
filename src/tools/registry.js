// Tool definition helper: schema + gate + handler live in one object, so the answer to
// "which tool needs the owner" is not scattered across the code.

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} [spec.parameters] JSON schema (default: no parameters)
 * @param {{keywords?: string[]} | null} [spec.gate] owner gate; keywords = the words the owner must have said
 * @param {boolean} [spec.asks] an open tool that can still put a question to the owner (see below)
 * @param {(args: object, deps: object, ctx: {name: string}) => Promise<object>} spec.handler
 */
export function defineTool({ name, description, parameters = { type: 'object', properties: {} }, gate = null, asks = false, handler }) {
	if (!name || typeof handler !== 'function') throw new Error(`incomplete tool definition: ${name}`);
	// Any owner-only tool can be made to wait for the owner's spoken yes (after other people's words were
	// read in the same turn; see untrustedGate in helpers.js), and the call that follows the answer carries
	// confirm:true. A schema without that field leaves the model no declared way to send it, and the
	// question would simply be asked again for ever, so every gated tool declares it. So does an open tool
	// that asks: one that calls the owner gate for some requests (a note about somebody else, a DM to
	// somebody else) or falls under the rule about other people's words (sending, private reads).
	const schema =
		(gate || asks) && !parameters.properties?.confirm ? { ...parameters, properties: { ...parameters.properties, confirm: P.confirm() } } : parameters;
	return {
		name,
		gate,
		asks: Boolean(asks),
		handler,
		definition: { type: 'function', name, description, parameters: schema },
	};
}

/** Schema shorthands. */
export const P = {
	str: (description) => ({ type: 'string', description }),
	int: (description) => ({ type: 'integer', description }),
	num: (description) => ({ type: 'number', description }),
	bool: (description) => ({ type: 'boolean', description }),
	list: (description) => ({ type: 'array', items: { type: 'string' }, description }),
	obj: (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) }),
	confirm: () => ({
		type: 'boolean',
		description: 'Confirmation step: leave empty on the first call (it only asks), set to true once the owner confirms',
	}),
};
