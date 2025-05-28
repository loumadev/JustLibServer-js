//@ts-check

const {EventListener, JLEvent, JLListener} = require("./JustLib.js");
// const {EventListener} = require("../justlib/JustLib.js");
const {Command, CommandSegment, GraphNode, CommandError, GraphGenerator, KeywordSegment, VariableSegment, Keyword, Variable, Union, Optional} = require("./command");

/**
 * @typedef {import("./command").MatchedNode} MatchedNode
 * @typedef {import("./command").MatchResult} MatchResult
 * @typedef {import("./command").CommandResult} CommandResult
 */

class CLI extends EventListener {
	/**
	 * @typedef {keyof typeof KEY} AvailableKeyMappings 
	 */

	/**
	 * @typedef {Object} AwaitingInputItem
	 * @prop {string} prompt 
	 * @prop {(input: string) => void} resolve 
	 * @prop {string} [cacheBuffer]
	 * @prop {number} [cacheCursor]
	 * @prop {string} [cachePrompt]
	 * @prop {string | null} [cacheHint]
	 * @prop {string | null} [cacheAutocomplete]
	 * @prop {boolean} [isActive] 
	 */

	/** @type {NodeJS.ReadStream} */
	stdin;
	/** @type {NodeJS.WriteStream} */
	stdout;
	/** @type {NodeJS.WriteStream} */
	stderr;
	/** @type {string} */
	prompt;
	/** @type {number} */
	promptLines;
	/** @type {string | null} */
	autocomplete;
	/** @type {string | null} */
	hint;
	/**
	 * Input buffer presented to the user
	 * @type {string}
	 */
	buffer;
	/**
	 * Current user input, not submitted yet.
	 * Used to preserve the input when navigating through the history.
	 * @type {string}
	 */
	current;
	/**
	 * Position of the cursor in the input buffer
	 * @type {number}
	 */
	cursor;
	/**
	 * Index of the history item in the history array
	 * @type {number}
	 */
	pointer;
	/** @type {boolean} */
	isResumed;
	/** @type {boolean} */
	printCommand;
	/** @type {boolean} */
	hasHint;
	/** @type {string[]} */
	history;
	/** @type {Command[]} */
	commands;
	/** @type {AwaitingInputItem[]} */
	awaitingInputsQueue;
	/** @type {[string, NodeJS.WritableStream][]} */
	keystrokeBuffer;
	/** @type {(...args: string[]) => void} */
	formatter;
	/** @type {Record<AvailableKeyMappings, number[]>} */
	keyMappings;

	/**
	 * @typedef {Object} CLIOptions
	 * @prop {NodeJS.ReadStream} [stdin] 
	 * @prop {NodeJS.WriteStream} [stdout] 
	 * @prop {NodeJS.WriteStream} [stderr] 
	 */

	/**
	 * Creates an instance of CLI.
	 * @param {CLIOptions} [options={}]
	 * @param {Partial<Record<AvailableKeyMappings, number[]>>} [customKeyMap={}]
	 * @memberof CLI
	 */
	constructor(options = {}, customKeyMap = {}) {
		super();

		/**
		 * @param {String} event Event name
		 * @param {Function} callback Event handler
		 * @type {
				EventListener["on"] &
				((event: 'command', listener: (event: JLEvent & CommandResult) => void) => JLListener) &
				((event: 'input', listener: (event: JLEvent & {input: string}) => void) => JLListener) &
				((event: 'stdout', listener: (event: JLEvent & {data: string, string: string}) => void) => JLListener) &
				((event: 'stderr', listener: (event: JLEvent & {data: string, string: string}) => void) => JLListener) &
				((event: 'stderr', listener: (event: JLEvent & {data: string, string: string}) => void) => JLListener) &
				((event: 'unknownCommand', listener: (event: JLEvent & {error: CommandError, input: string}) => void) => JLListener) &
				((event: 'error', listener: (event: JLEvent & {error: Error | CommandError}) => void) => JLListener) &
				((event: 'keypress', listener: (event: JLEvent & {sequence: string, buffer: string[], stream: NodeJS.WritableStream}) => void) => JLListener) &
				((event: 'keyinput', listener: (event: JLEvent & {key: string, buffer: string[], stream: NodeJS.WritableStream}) => void) => JLListener) &
				((event: 'SIGINT', listener: (event: JLEvent) => void) => JLListener) &
				((event: 'load', listener: (event: JLEvent) => void) => JLListener)
			}
		*/
		// @ts-ignore
		this.on;


		const {
			stdin = process.stdin,
			stdout = process.stdout,
			stderr = process.stderr
		} = options;

		this.stdin = stdin;
		this.stdout = stdout;
		this.stderr = stderr;

		this.prompt = "> ";
		this.promptLines = 1;
		this.autocomplete = null;
		this.hint = null;
		this.buffer = "";
		this.current = "";
		this.cursor = 0;
		this.pointer = 0;
		this.isResumed = false;
		this.printCommand = true;
		this.hasHint = false;

		this.history = [];
		this.commands = [];
		this.awaitingInputsQueue = [];
		this.keystrokeBuffer = [];

		try {
			const server = require("./server").Server;
			this.formatter = server.formatMessage.bind(server);
		} catch(err) {
			this.formatter = msg => msg;
		}

		this.keyMappings = {...KEY, ...customKeyMap};
	}

	begin() {
		// Setup stdin
		this.stdin?.setRawMode?.(true);
		this.stdin?.setEncoding?.("utf8");
		this.stdin.on("data", key => this._keyPressed(/**@type {string}*/(/**@type {any}*/(key)), this.stdout));

		// Setup stdout
		this.stdout?.setEncoding?.("utf8");
		this.stdout["__write"] = this.stdout.write;
		// @ts-ignore
		this.stdout.write = (string, encoding, fd) => {
			const result = this.stdout["__write"].apply(this.stdout, ["\r\x1b[K" + string, encoding, fd]);
			this._updateCLI();
			this.dispatchEvent("stdout", {data: string, string: this._unescape(/**@type {string}*/(string))});

			return result;
		};

		// Setup stderr
		this.stderr?.setEncoding?.("utf8");
		this.stderr["__write"] = this.stderr.write;
		// @ts-ignore
		this.stderr.write = (string, encoding, fd) => {
			const result = this.stderr["__write"].apply(this.stderr, ["\r\x1b[K" + string, encoding, fd]);
			this._updateCLI();
			this.dispatchEvent("stderr", {data: string, string: this._unescape(/**@type {string}*/(string))});

			return result;
		};

		// Begin
		this.stdout.write(this.prompt);
		this.resume();

		/** @type {{ target: string, raw: string, text: string} | null} */
		let autocomplete = null;

		// Add internal event handler for interactive hints and autocomplete
		this.on("keypress", async e => {
			// If there is some awaiting prompt, do not process the input
			if(this.awaitingInputsQueue.length) return;

			// Input buffer was cleared, so clear the hint and auto completion as well
			if(!this.buffer.length) {
				this.setHint(null);
				this.setAutocomplete(null);
				return;
			}

			// Tokenize the input buffer
			let argv = [];
			try {
				argv = this.parseArgv(this.buffer);
			} catch(err) {
				this.setAutocomplete(null);
				this.setHint(`§4Error: ${err.message}`);
				return;
			}

			/** @type {(MatchResult & {command: Command})[]} */
			const matches = [];

			// Lookup each command
			for(const command of this.commands) {
				// Match the input with the command graph
				const result = /**@type {typeof matches}*/(GraphGenerator.processInput(argv, command.graph));

				// Add command reference to the results
				result.forEach(e => e.command = command);

				// Add matching command to the list
				if(result.length) matches.push(...result);
			}

			/** @type {Set<string>} */
			const keywords = new Set();

			/** @type {Map<string, {types: Set<string>, enums: Set<string>}>} */
			const variables = new Map();

			let isInvokable = false;

			// Reduce all possible combinations of matched segments to unique segments
			for(const match of matches) {
				const node = match.nodes.at(-1);
				if(!node) continue;

				const segment = node.node.segment;

				isInvokable ||= match.isInvokable;

				if(segment instanceof KeywordSegment) {
					keywords.add(segment.name);
				} else if(segment instanceof VariableSegment) {
					const values = variables.get(segment.name) || {
						types: new Set(),
						enums: new Set(node.enums)
					};

					if(segment.type) {
						values.types.add(segment.type);
					}

					// if(segment.enum || segment._provided_enum) {
					// 	for(const value of segment.enum || segment._provided_enum || []) {
					// 		values.enums.add(value);
					// 	}
					// }

					variables.set(segment.name, values);
				}
			}

			const keywordsStr = [...keywords]
				.map(name => `§8Keyword §3${name}`);

			const variablesStr = [...variables.entries()]
				.map(([name, {types, enums}]) => {
					const multTypes = types.size + enums.size > 1;

					const typesStr = [...types].map(e => `§5${e}`);
					const enumsStr = [...enums].map(e => `§6"${e}"`);
					const LParen = multTypes ? "§8(" : "";
					const RParen = multTypes ? "§8)" : "";

					return `§8${LParen}${[...typesStr, ...enumsStr].slice(0, 10).join("§8 | ")}${RParen} §3${name}`;
				});

			const simplified = [...keywordsStr, ...variablesStr];
			if(isInvokable) simplified.push("§eCR");

			// Generate command hint
			this.setHint(simplified.join("§8 | ") || "§4Error", false);

			// Generate possible completions
			autocomplete = (() => {
				const match = matches
					.sort((a, b) => {
						const aSegment = a.nodes.at(-1)?.node.segment;
						const bSegment = b.nodes.at(-1)?.node.segment;

						const isAVariable = aSegment instanceof VariableSegment;
						const isBVariable = bSegment instanceof VariableSegment;
						const isAKeyword = aSegment instanceof KeywordSegment;
						const isBKeyword = bSegment instanceof KeywordSegment;

						if(isAVariable && isBVariable) {
							const aEnum = aSegment.enum || aSegment._provided_enum;
							const bEnum = bSegment.enum || bSegment._provided_enum;

							if(aEnum && bEnum) return bEnum.length - aEnum.length;
							if(aEnum) return -1;
							if(bEnum) return 1;
						}

						if(isAKeyword && isBKeyword) return 0;
						if(isAKeyword) return -1;
						if(isBKeyword) return 1;

						return 0;
					})
					.sort((a, b) => +b.isInvokable - +a.isInvokable)[0];
				if(!match) return null;

				const node = match.nodes.at(-1);
				if(!node) return null;

				const segment = node.node.segment;
				const isKeyword = segment instanceof KeywordSegment;
				const isVariable = segment instanceof VariableSegment;

				if(!isKeyword && !isVariable) throw new Error("Invalid segment type");

				let text = segment.name;

				// Pick an autocomplete value based on the segment type
				if(isVariable) {
					// Segment is a flag variable
					if(segment.type === "flag") {
						// Do not need to change anything, the text is already the flag name
					}
					// Segment is an enum variable
					else if(node.enums.length !== 0) {
						// TODO: add some strategy to select the most probable value (maybe based on history?)
						text = node.enums/* .sort((a, b) => b.length - a.length) */[0];
					}
				}

				// Format the completion
				const rawText = text.slice(node.raw.length);

				return {
					target: text,
					raw: rawText,
					text: `§8${rawText}`
				};
			})();

			// Get the comment of the current segment(s)
			const comment = (function() {
				const match = matches.sort((a, b) => +b.isInvokable - +a.isInvokable)[0];
				if(!match) return null;

				const segment = match.nodes.at(-1)?.node.segment;
				if(!segment) return null;

				// Format the comment
				return segment.comment ? `    §8#${segment.comment}` : null;
			})();

			// Set the autocomplete to combination of possible completion and comment
			this.setAutocomplete((autocomplete?.text || "") + (comment || "") || null, false);

			// Exit if the command is not invokable
			if(!isInvokable) return;

			// Asynchronously try to resolve the command preview
			let preview = null;

			// Dispatch event for command preview
			const result = this.resolveCommand(matches);

			// If the command has no listeners for preview event, exit
			if(!result.command.hasListeners("preview")) return;

			await result.command.dispatchEvent("preview", {
				async: true,
				parallel: true,
				input: this.buffer,
				argv: argv,
				autocompleteTarget: autocomplete?.target || null,
				preview: preview,
				...result
			}, e => {
				if(!e.preview) return;

				preview = `    §8=> §r${e.preview}`;
			});

			// If there is no preview, exit
			if(!preview) return;

			// Set the autocomplete to combination of possible completion and comment
			this.setAutocomplete((autocomplete?.text || "") + (preview || "") + (comment || "") || null);
		});

		// Add internal event handler for submitting completion suggestions using tab key
		this.on("keyinput", e => {
			if(e.key !== "\t") return;

			if(!autocomplete?.raw) return e.stream.write("\x07"), e.preventDefault();

			e.key = autocomplete.raw.replace(/§[0-9a-fr]/g, "");
			this.setAutocomplete(null, false);
		});

		this.dispatchEvent("load");
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @param {{prompt?: string | undefined, hint?: string | undefined, autocomplete?: string | undefined}} options
	 * @param {boolean} [rerender=true]
	 * @memberof CLI
	 */
	setParameters(options = {}, rerender = true) {
		const {
			prompt = undefined,
			hint = undefined,
			autocomplete = undefined
		} = options;

		if(typeof prompt !== "undefined") this.prompt = prompt || "";
		if(typeof hint !== "undefined") this.hint = hint || null;
		if(typeof autocomplete !== "undefined") this.autocomplete = autocomplete || null;
		if(this.hint) this.hasHint = true;

		if(rerender) this._updateCLI();
	}

	/**
	 * @param {string} prompt
	 * @param {boolean} [rerender=true]
	 * @memberof CLI
	 */
	setPrompt(prompt, rerender = true) {
		this.prompt = prompt || "";
		this.promptLines = this.prompt.split("\n").length;

		if(rerender) this._updateCLI();
	}

	/**
	 * @param {string | null} hint
	 * @param {boolean} [rerender=true]
	 * @memberof CLI
	 */
	setHint(hint, rerender = true) {
		this.hint = hint || null;
		if(this.hint) this.hasHint = true;

		if(rerender) this._updateCLI();
	}

	/**
	 * @param {string | null} text
	 * @param {boolean} [rerender=true]
	 * @memberof CLI
	 */
	setAutocomplete(text, rerender = true) {
		this.autocomplete = text || null;

		if(rerender) this._updateCLI();
	}

	/**
	 * @param {boolean} state
	 * @memberof CLI
	 */
	setPrintCommand(state) {
		this.printCommand = !!state;
	}

	/**
	 * @memberof CLI
	 */
	pause() {
		this.isResumed = false;
		this.stdin.pause();
	}

	/**
	 * @memberof CLI
	 */
	resume() {
		this.isResumed = true;
		this.stdin.resume();

		// Process all buffered keystrokes
		this._processKeystrokeBuffer();
	}

	/**
	 * @param {string} input
	 * @param {CLI} [cli=this]
	 * @param {NodeJS.WritableStream} [targetStream=this.stdout]
	 * @return {void} 
	 * @memberof CLI
	 */
	sendInput(input, cli = this, targetStream = this.stdout) {
		const inputLine = cli.prompt + input;

		// Output
		if(this.printCommand) this.dispatchEvent("stdout", {
			data: inputLine + "\n",
			string: cli._unescape(inputLine + "\n")
		});

		// Input
		targetStream["__write"].apply(targetStream, [`\r\x1b[K${this.printCommand ? inputLine + "\r\n" : ""}${cli.prompt}`]);

		this.dispatchEvent("input", {input}, e => {
			// Events
			if(this.awaitingInputsQueue.length === 0) {
				// Try to handle the command from input
				try {
					const result = this.parseInput(input);
					if(result) {
						// Command was parsed successfully, emit command event and run the command handler
						this.dispatchEvent("command", {...result}, e => {
							result.command.callback(result);
						});
					}
				} catch(error) {
					// Failed to handle the command, emit an error event or throw an error
					if(error instanceof CommandError && error.code === Command.ERROR.UNKNOWN_COMMAND) {
						this.dispatchEvent("unknownCommand", {
							error: error,
							input: input
						}, e => {
							throw error;
						});

						return;
					}

					this.dispatchEvent("error", {error}, e => {
						throw error;
					});
				}
			} else if(this.awaitingInputsQueue[0].isActive) {
				const awaitingInput = this.awaitingInputsQueue.shift();
				if(!awaitingInput) return; // never

				// Resolve the input promise
				awaitingInput.resolve(input);

				// Restore the previous input buffer, prompt, hint and autocomplete
				this.buffer = awaitingInput.cacheBuffer || "";
				this.cursor = awaitingInput.cacheCursor || 0;
				this.setHint(awaitingInput.cacheHint || null, false);
				this.setAutocomplete(awaitingInput.cacheAutocomplete || null, false);
				this.setPrompt(awaitingInput.cachePrompt || "", false);

				// Render the prompt in the terminal, only if there are no more prompts awaiting (to prevent overdraw)
				if(this.awaitingInputsQueue.length === 0) {
					this._updateCLI();
				}
			}
		});

		// In case there are more prompts awaiting, make the next one in the queue active
		this._makeNextPromptActive();
	}

	/**
	 * @param {string} [prompt=this.prompt]
	 * @return {Promise<string>} 
	 * @memberof CLI
	 */
	getInput(prompt = this.prompt) {
		return new Promise((resolve, reject) => {
			this.awaitingInputsQueue.push({
				prompt: prompt,
				resolve: resolve,
				// will be set later
				cacheBuffer: "",
				cacheCursor: 0,
				cachePrompt: "",
				cacheHint: null,
				cacheAutocomplete: null,
				isActive: false
			});

			this._makeNextPromptActive();
		});
	}

	/**
	 * @private
	 * @memberof CLI
	 */
	_makeNextPromptActive() {
		// Get the next prompt in the queue
		const awaitingInput = this.awaitingInputsQueue[0];
		if(!awaitingInput) return;

		// If there is already an active prompt, exit
		if(awaitingInput.isActive) return;

		// Cache current props and make the prompt active
		awaitingInput.cacheBuffer = this.buffer;
		awaitingInput.cacheCursor = this.cursor;
		awaitingInput.cachePrompt = this.prompt;
		awaitingInput.cacheHint = this.hint;
		awaitingInput.cacheAutocomplete = this.autocomplete;
		awaitingInput.isActive = true;

		// Render the prompt in the terminal (and reset the hint and autocomplete)
		this.buffer = "";
		this.cursor = 0;
		this.setAutocomplete(null, false);
		this.setHint(null, false);
		this.setPrompt(awaitingInput.prompt, true);
	}


	/**
	 * @param {string} input
	 * @return {string[]} 
	 * @memberof CLI
	 */
	parseArgv(input) {
		if(!input) return [];

		// @ts-ignore
		const argv = [...input.matchAll(/(?:(?<=^|\x20)(["'])((?:\\\1|.)*)\1(?=$|\x20)|[^\x20\n]+)/g)].map(e => e[2] ? e[2].replaceAll("\\" + e[1], "\"") : e[0]);
		if(input.endsWith(" ")) argv.push("");

		return argv;

		// const argv = [];

		// {
		// 	// Setup state variables
		// 	let buffer = "";
		// 	let quote = false;
		// 	let escape = false;

		// 	// Tokenize the input
		// 	for(const char of input) {
		// 		if(char === " " && !quote) {
		// 			if(buffer) argv.push(buffer);
		// 			buffer = "";
		// 		} else if(char === "\"" && !escape) {
		// 			quote = !quote;
		// 		} else if(char === "\\" && !escape) {
		// 			escape = true;
		// 		} else {
		// 			// The escaped character wasn't quote => preserve escape sequences
		// 			if(escape) buffer += "\\";

		// 			buffer += char;
		// 			escape = false;
		// 		}
		// 	}

		// 	// Push the last buffer
		// 	argv.push(buffer);

		// 	// Check for unmatched quote
		// 	if(quote) throw new CommandError("Unmatched quote", Command.ERROR.UNMATCHED_QUOTE);
		// }

		// Return the parsed arguments
		return argv;
	}

	/**
	 * @param {string} input
	 * @return {*} 
	 * @memberof CLI
	 */
	parseInput(input) {
		if(!input) return null;

		// Tokenize the input
		const argv = this.parseArgv(input);

		/** @type {(MatchResult & {command: Command})[]} */
		const matches = [];

		// Lookup each command
		for(const cmd of this.commands) {
			// Match the input with the command graph
			const result = /**@type {typeof matches}*/(GraphGenerator.processInput(argv, cmd.graph));

			// Add command reference to the results
			result.forEach(e => e.command = cmd);

			// Add matching command to the list
			if(result.length) matches.push(...result);
		}

		// No matching command found
		if(!matches.length) {
			throw new CommandError("Unknown command", Command.ERROR.UNKNOWN_COMMAND);
		}

		// Return matched results
		return {
			input: input,
			argv: argv,
			...this.resolveCommand(matches)
		};
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @param {(MatchResult & {command: Command})[]} results
	 * @returns {{command: Command, variables: Record<string, any>, segments: MatchedNode[]}}
	 * @memberof CLI
	 */
	resolveCommand(results) {
		const invokable = results.filter(e => e.isInvokable);

		// None of the commands are invokable
		if(!invokable.length) {
			throw new CommandError("Incomplete command", Command.ERROR.INCOMPLETE_COMMAND);
		}

		let candidate = invokable[0];

		// Multiple invokable commands found
		if(invokable.length > 1) {
			// Try to resolve the ambiguity first
			// 1. Other datatypes have higher priority than string
			// 2. Enum variable has higher priority than regular variable
			// 3. Keyword has higher priority than variable

			const cadidates = Array.from(invokable, cmd => ({command: cmd, score: 0}));

			for(let i = 0; i < invokable[0].nodes.length; i++) {
				for(let j = 0; j < invokable.length; j++) {
					const node = invokable[j].nodes[i];
					const segment = node.node.segment;

					if(segment instanceof KeywordSegment) {
						cadidates[j].score += 4;
					} else if(segment instanceof VariableSegment) {
						if(segment.enum || segment._provided_enum) {
							cadidates[j].score += 3;
						} else if(segment.type && segment.type !== "string") {
							cadidates[j].score += 2;
						} else {
							cadidates[j].score += 1;
						}
					}
				}
			}

			// Select the command with the highest score
			cadidates.sort((a, b) => b.score - a.score);

			const first = cadidates[0];
			const filtered = cadidates.filter(e => e.score === first.score);

			// Ambiguous command
			if(filtered.length > 1) throw new CommandError(`Ambiguous command: ${filtered.map(e => e.command.command.name).join(", ")}`, Command.ERROR.AMBIGUOUS_COMMAND);

			candidate = cadidates[0].command;
		}

		// Return matched results
		return {
			command: candidate.command,
			variables: candidate.nodes
				.reduce((obj, e) => {
					const segment = e.node.segment;
					if(segment instanceof VariableSegment) {
						const name = segment.name;

						if(segment.isRest) {
							if(!Array.isArray(obj[name])) {
								obj[name] = [];
							}

							obj[name].push(e.value);
						} else {
							obj[name] = e.value;
						}
					}

					return obj;
				}, {}),
			segments: invokable[0].nodes
		};
	}

	/**
	 * @param {Command} command
	 * @memberof CLI
	 */
	registerCommand(command) {
		this.commands.push(command);
	}

	/**
	 * @memberof CLI
	 */
	_updateCLI() {
		const offset = this.prompt.length + this.cursor + 1;

		const START = `\x1b[1G`;
		const UP = `\x1b[1A`;
		const DOWN = `\x1b[1B`;
		const ERASE_LINE = `\x1b[K`;
		const OFFSET_CURSOR = `\x1b[${offset}G`;

		const autocomplete = this.formatter(this.autocomplete || "");
		const hint = this.hint ? `\n${ERASE_LINE}${this.formatter(this.hint)}${UP}` : this.hasHint && !(this.hasHint = false) ? `\n${ERASE_LINE}${UP}` : "";

		const CLEAR_PROMPT_LINES = this.promptLines == 29 ? `${UP}${ERASE_LINE}\n${UP}\n${DOWN}` : "";
		//`${UP}${START}${ERASE_LINE}`.repeat(this.promptLines - 1); //+ `${DOWN}`;//.repeat(this.promptLines - 1);

		const width = this.stdout.columns;

		let inputLine = `${this.prompt}${this.buffer}${autocomplete}`;
		const len = this._unescape(inputLine).length;
		if(len > width) inputLine = `${inputLine.slice(0, width - 1)}>`;

		const output = `${START}${ERASE_LINE}${CLEAR_PROMPT_LINES}${inputLine}${START}${hint}${OFFSET_CURSOR}`;

		this.stdout["__write"].apply(this.stdout, [output]);
	}

	/**
	 * @param {string} string
	 * @return {string} 
	 * @memberof CLI
	 */
	_unescape(string) {
		return string.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	}

	/**
	 * @param {any[]} buffer1
	 * @param {any[]} buffer2
	 * @return {boolean} 
	 * @memberof CLI
	 */
	_keyCompare(buffer1, buffer2) {
		if(!buffer1 || !buffer2) return false;
		if(buffer1.length != buffer2.length) return false;

		for(let i = 0; i < buffer1.length; i++) {
			if(buffer1[i] != buffer2[i]) return false;
		}

		return true;
	}

	/**
	 * @param {string} key
	 * @param {NodeJS.WritableStream} [stream=this.stdout]
	 * @memberof CLI
	 */
	_keyPressed(key, stream = this.stdout) {
		// If the pressed key is SIGINT, dispatch the SIGINT event and kill the process eventually
		if(this.keyMappings.SIGINT.every((e, i) => e === key.charCodeAt(i))) {
			this.dispatchEvent("SIGINT", {}, e => {
				// If the event is not prevented, kill the process
				process.kill(process.pid, "SIGINT");
			});
			return;
		}

		// If the stream is paused, buffer the input
		if(!this.isResumed) {
			this.keystrokeBuffer.push([key, stream]);
			return;
		}

		// If the key is an escape sequence, process it as a single key
		if(key.charCodeAt(0) === 27) {
			this._keyProcess(key, stream);
			return;
		}

		// Process the key buffer
		for(let i = 0; i < key.length; i++) {
			const ch = key[i];
			this._keyProcess(ch, stream);
			// console.log({ch, code: ch.charCodeAt(0), isResumed: this.isResumed});

			// By the time the key is processed, the CLI might be paused
			if(!this.isResumed) {
				this.keystrokeBuffer.push([key.substring(i + 1), stream]);
				break;
			}
		}
	}

	/**
	 * @memberof CLI
	 */
	_processKeystrokeBuffer() {
		if(this._isProcessingKeystrokeBuffer) return;
		this._isProcessingKeystrokeBuffer = true;

		const keystrokes = this.keystrokeBuffer;
		this.keystrokeBuffer = [];

		for(const keystroke of keystrokes) {
			const [buffer, stream] = keystroke;
			this._keyPressed(buffer, stream);
		}

		this._isProcessingKeystrokeBuffer = false;
	}

	/**
	 * @param {string} key
	 * @param {NodeJS.WritableStream} [stream=this.stdout]
	 * @return {void} 
	 * @memberof CLI
	 */
	_keyProcess(key, stream = this.stdout) {
		const buffer = [...key].map(e => e.charCodeAt(0));

		let shouldUpdate = false;

		if(this._keyCompare(buffer, this.keyMappings.ARROW_UP)) {
			if(this.pointer == this.history.length)
				this.current = this.buffer;
			if(this.pointer) {
				this.buffer = this.history[--this.pointer];
				this.cursor = this.buffer.length;

				// this._updateCLI();
				shouldUpdate = true;
			}
		}
		else if(this._keyCompare(buffer, this.keyMappings.ARROW_DOWN)) {
			if(this.pointer < this.history.length) {
				this.buffer = this.history[++this.pointer] || this.current;
				this.cursor = this.buffer.length;

				// this._updateCLI();
				shouldUpdate = true;
			}
		}
		else if(this._keyCompare(buffer, this.keyMappings.ARROW_LEFT)) {
			this.cursor--;
			if(this.cursor < 0)
				this.cursor = 0;
			else
				stream["__write"].apply(stream, [key]);
		}
		else if(this._keyCompare(buffer, this.keyMappings.ARROW_RIGHT)) {
			this.cursor++;
			if(this.cursor > this.buffer.length)
				this.cursor = this.buffer.length;
			else
				stream["__write"].apply(stream, [key]);
		}
		else if(this._keyCompare(buffer, this.keyMappings.CTRL_ARROW_LEFT)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index).reverse();
			const index = jumps.find(e => e < this.cursor && this.cursor - e != 1) || 0;

			this.cursor = index;
			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.CTRL_ARROW_RIGHT)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index);
			const index = jumps.find(e => e > this.cursor && e - this.cursor != 1) || this.buffer.length;

			this.cursor = index;
			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.BACKSPACE)) {
			this.cursor--;
			if(this.cursor < 0)
				return void (this.cursor = 0);
			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(this.cursor + 1);

			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.DELETE)) {
			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(this.cursor + 1);

			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.CTRL_BACKSPACE)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index).reverse();
			const index = jumps.find(e => e < this.cursor && this.cursor - e != 1) || 0;

			this.buffer = this.buffer.substring(0, index) + this.buffer.substring(this.cursor);
			this.cursor = index;

			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.CTRL_DELETE)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index);
			const index = jumps.find(e => e > this.cursor && e - this.cursor != 1) || this.buffer.length;

			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(index);

			// this._updateCLI();
			shouldUpdate = true;
		}
		else if(this._keyCompare(buffer, this.keyMappings.RETURN)) {
			if(this.buffer && this.buffer != this.history[this.history.length - 1])
				this.pointer = this.history.push(this.buffer);
			else
				this.pointer = this.history.length;

			const input = this.buffer;
			this.buffer = "";
			this.cursor = 0;
			this.sendInput(input, this, this.stdout);
		}
		else {
			this.dispatchEvent("keyinput", {
				key: key,
				buffer: this.buffer,
				stream: stream
			}, e => {
				// Decode Ctrl+Key keys
				if(e.key.length == 1 && e.key.charCodeAt(0) < 32) {
					e.key = "^" + String.fromCharCode(e.key.charCodeAt(0) + 64);
				}

				// Add key to input buffer
				this.buffer = this.buffer.substring(0, this.cursor) + e.key + this.buffer.substring(this.cursor);
				this.cursor += e.key.length;

				// this._updateCLI();
				shouldUpdate = true;
			});
		}

		this.dispatchEvent("keypress", {sequence: key, buffer: buffer, stream: stream});

		if(shouldUpdate) this._updateCLI();
	}
}

const KEY = {
	SIGINT: [3],
	RETURN: [13],
	BACKSPACE: [8],
	CTRL_BACKSPACE: [127],
	DELETE: [27, 91, 51, 126],
	CTRL_DELETE: [27, 91, 51, 59, 53, 126],
	ARROW_UP: [27, 91, 65],
	ARROW_DOWN: [27, 91, 66],
	ARROW_LEFT: [27, 91, 68],
	CTRL_ARROW_LEFT: [27, 91, 49, 59, 53, 68],
	ARROW_RIGHT: [27, 91, 67],
	CTRL_ARROW_RIGHT: [27, 91, 49, 59, 53, 67]
};

module.exports = {
	CLI,
	KEY
};