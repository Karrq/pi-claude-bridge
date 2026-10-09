// Shared stub pi for calling the extension's default export in unit tests.
// Returns the Map of event handlers the stub recorded. Pass activateFn to
// override the activate function (e.g. a freshly re-imported module instance).
//
// registerTool is stubbed too: activate() calls pi.registerTool when the loaded
// config enables AskClaude (e.g. a developer's global ~/.pi/agent/claude-bridge.json),
// so a mock missing it throws before any handler is registered. CI has no such
// config, which is why this only surfaced locally.
//
// Several handlers per event are composed the way pi's own runner composes them
// (dist/core/extensions/runner.js emit): every registration runs in order, and a
// handler's returned value overrides the one before it. Keeping only the last
// registration silently dropped the earlier ones the moment the extension
// registered a second handler for an event (cache warming does this for
// before_agent_start, agent_start, turn_start, model_select, session_tree,
// session_before_compact, session_start and session_shutdown).
const { default: activate } = await import("../../src/index.js");

export function activateWithMockPi(activateFn) {
	const handlers = new Map();
	const commands = new Map();
	const compose = (previous, handler) => (eventArg, ctx = {}) => {
		const result = handler(eventArg, ctx);
		// Promise-aware but not promise-forcing: the capture tests call these handlers
		// and assert synchronously, so a sync handler pair must stay sync.
		if (result && typeof result.then === "function") {
			return result.then((settled) => settled ?? previous(eventArg, ctx));
		}
		return result ?? previous(eventArg, ctx);
	};
	(activateFn ?? activate)({
		on: (event, handler) => {
			const previous = handlers.get(event);
			handlers.set(event, previous ? compose(previous, handler) : handler);
		},
		registerProvider: () => {},
		registerTool: () => {},
		registerCommand: (name, options) => { commands.set(name, options); },
	});
	handlers.commands = commands;
	return handlers;
}
