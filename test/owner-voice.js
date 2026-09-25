// The owner answering a question out loud, for tests that are about a tool rather than the voice path.
//
// A two-step confirmation acts only on a yes the owner said after the question was put, in a later turn
// than the one that asked it. This keeps exactly that much of a conversation on a deps object: a turn
// that moves on whenever somebody speaks, and the owner's words since a mark. The real thing is
// SpeakerAttribution.mark / ownerSpeechSince, which test/unit/confirmation.test.js drives end to end.
export function ownerVoice(deps) {
	const said = [];
	let turn = { at: 1 };
	deps.currentTurn = () => turn;
	deps.speechMark = () => ({ seq: said.length });
	deps.ownerSpeechSince = (mark) => {
		const text = said.slice(mark?.seq ?? 0).join(' ');
		return text ? { text } : null;
	};
	return {
		/** The owner says this, and the model starts a new turn answering it. */
		says(text) {
			said.push(text);
			turn = { at: turn.at + 1 };
		},
		/** The turn the next call belongs to. */
		get turn() {
			return turn;
		},
	};
}
