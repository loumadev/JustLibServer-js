//@ts-check

const {EventListener, JLEvent, JLListener} = require("./JustLib.js");

/**
 * @typedef {Object} MatchedNode
 * @prop {GraphNode} node
 * @prop {string} raw
 * @prop {any} value
 * @prop {string[]} enums
 */

/**
 * @typedef {Object} MatchResult
 * @prop {MatchedNode[]} nodes
 * @prop {boolean} isPartial
 * @prop {boolean} isInvokable
 */

/**
 * @typedef {Object} ResolvedCommand
 * @prop {Command} command
 * @prop {Record<string, any>} variables
 * @prop {MatchedNode[]} segments 
 */

/**
 * @typedef {Object} CommandInput 
 * @prop {string} input
 * @prop {string[]} argv
 */

/**
 * @typedef {ResolvedCommand & CommandInput} CommandResult
 */

class GraphNode {
	/**
	 * @param {CommandSegment} segment
	 * @param {GraphNode[]} edges
	 */
	constructor(segment, edges) {
		/** @type {CommandSegment} */
		this.segment = segment;

		/** @type {GraphNode[]} */
		this.edges = edges;
	}
}

class GraphGenerator {
	constructor() {
		/** @type {Map<CommandSegment, GraphNode>} */
		this.nodeCache = new Map();
		/** @type {Generator<number, number, number>} */
		this.idGenerator = GraphGenerator.IdGenerator();
	}

	/**
	 * @param {CommandSegment[]} segments
	 * @returns {[GraphNode, GraphNode]}
	 * @memberof Command
	 */
	generateGraph(segments) {
		const [bof, eof] = this.createMarkerSet();

		// Keep the current solid node to create forward references
		let currentNode = bof;

		// Keep the optional chain to create chaining references
		let optionalChain = [];

		/**
		 * @param {GraphNode} endNode
		 */
		function __createOptionalChaining(endNode) {
			// Add a solid node to the end of the chain
			optionalChain.push([endNode, null]);

			// Create the chainings
			for(let i = 0; i < optionalChain.length; i++) {
				for(let j = i + 1; j < optionalChain.length; j++) {
					optionalChain[i][1].edges.push(optionalChain[j][0]);
				}
			}

			// Clear the chain
			optionalChain = [];
		}

		for(const segment of segments) {
			if(segment instanceof OptionalSegment) {
				const [optBof, optEof] = this.generateGraph(segment.segments);

				// Save the node to the optional chain for later chaining
				optionalChain.push([optBof, optEof]);

				// Create a forward reference from solid node to the optional chain
				currentNode.edges.push(optBof);
			} else if(segment instanceof UnionSegment) {
				const [unionBof, unionEof] = this.createMarkerSet();

				// Create a forward reference from the current solid node to the union bof
				currentNode.edges.push(unionBof);

				// Create the union nodes
				for(const unionSegment of segment.subSegments) {
					const [unionSegmentBof, unionSegmentEof] = this.generateGraph(unionSegment);

					// Create a forward reference from the union bof to the union segment bof
					unionBof.edges.push(unionSegmentBof);

					// Create a forward reference from the union segment eof to the union eof
					unionSegmentEof.edges.push(unionEof);
				}

				currentNode = unionEof;
			} else {
				// Create a new solid node
				const newNode = this.createNode(segment);

				// Create a forward reference from the current solid node to the new solid node and make it the current solid node
				currentNode.edges.push(newNode);
				currentNode = newNode;

				// If the command segment is a rest variable, create a reference to itself
				if(segment instanceof VariableSegment && segment.isRest) {
					currentNode.edges.push(currentNode);
				}

				// Create the optional chainings
				if(optionalChain.length > 0) __createOptionalChaining(newNode);
			}
		}

		// If there are any optional chains left, create the chainings (last command segment is optional)
		if(optionalChain.length > 0) {
			__createOptionalChaining(eof);
		}

		// Add an EOF node to the end of the solid node
		currentNode.edges.push(eof);

		return [bof, eof];
	}

	/**
	 * @param {string[]} argv
	 * @param {GraphNode} graph
	 * @returns {MatchResult[]}
	 */
	static processInput(argv, graph) {
		/** @type {MatchResult[]} */
		const matches = [];

		// EOF/BOF nodes are epsilon nodes, so they are not included in the segments
		// EOF with id 0 is final node
		// EOF/BOF can contains multiple edges (they have purpose of some kind of hub)

		/** @type {{node: GraphNode, match: MatchResult, index: number}[]} */
		const stack = [{
			node: graph,
			match: {
				nodes: [],
				isPartial: false,
				isInvokable: false
			},
			index: 0
		}];

		while(stack.length > 0) {
			const item = stack.pop(); if(!item) continue;
			const {node, match, index} = item;

			const segment = node.segment;
			const arg = argv[index];

			/** @type {MatchedNode} */
			const currentMatchNode = {node, raw: arg, value: arg, enums: []};

			/** @type {MatchResult} */
			const newMatch = {
				nodes: [...match.nodes, currentMatchNode],
				isPartial: false,
				isInvokable: false
			};

			const isControl = segment instanceof ControlSegment;
			const isFinalEOF = isControl && !segment.isBof && segment.id === 0;
			const hasMoreArguments = index < argv.length;
			const isLastArgument = index === argv.length - 1;

			// console.log(hasMoreArguments);

			// No more arguments to consume, but we are still not at the end of the command (partial match)
			if(!isControl && !hasMoreArguments) {
				match.isPartial = true;
				matches.push(match);
				continue;
			}

			if(segment instanceof ControlSegment) {
				if(segment.isBof) {
					stack.push(...node.edges.map(node => ({node, match, index})));
				} else {
					stack.push(...node.edges.map(node => ({node, match, index})));

					// Is final EOF and no more arguments to consume (full match)
					if(isFinalEOF && !hasMoreArguments) {
						match.isInvokable = true;
						matches.push(match);
					}
				}
			} else if(segment instanceof KeywordSegment) {
				const isPartial = segment.name.startsWith(arg);
				const isFull = isPartial && segment.name.length === arg.length;

				if(isFull) {
					stack.push(...node.edges.map(node => ({node, match: newMatch, index: index + 1})));
				} else if(isPartial && isLastArgument) { // Do not match partially matched keywords in the middle of the command
					matches.push(newMatch);
				} else {
					// No match
				}
			} else if(segment instanceof VariableSegment) {
				// Check types
				const isTypeMatch = segment.type && VariableSegment.compareType(arg, segment);
				const isEmptyNonString = segment.type !== "string" && arg === "";

				// Get enum to check
				const computedEnum = segment.enum ||
					segment.provider && (segment._provided_enum = segment.provider()) ||
					null;
				const matchingEnums = computedEnum?.filter(e => e.startsWith(arg)) || [];

				// Check enums
				const hasMatchingEnums = matchingEnums.length > 0;
				const isEnumMatch = matchingEnums.length === 1 && matchingEnums[0].length === arg.length;

				// Check flag
				const hasMatchingFlag = segment.type === "flag" && segment.name.startsWith(arg);
				const isFlagMatch = segment.type === "flag" && arg === segment.name;

				// Check if partial or full
				const isPartial = isEmptyNonString || hasMatchingEnums || hasMatchingFlag;
				const isFull = isTypeMatch || isEnumMatch || isFlagMatch;

				// Parse value
				if(isTypeMatch && segment.type) {
					currentMatchNode.value = VariableSegment.parseValue(arg, segment);
				}

				// Add matching enums
				if(matchingEnums.length) {
					currentMatchNode.enums = matchingEnums;
				}

				if(isFull) {
					stack.push(...node.edges.map(node => ({node, match: newMatch, index: index + 1})));
				} else if(isPartial) {
					matches.push(newMatch);
				} else {
					// No match
				}
			}
		}

		return [...new Set(matches)];
	}

	/**
	 * @param {CommandSegment} segment
	 * @return {GraphNode} 
	 * @memberof GraphGenerator
	 */
	createNode(segment) {
		const cachedNode = this.nodeCache.get(segment);
		if(cachedNode) return cachedNode;

		const node = new GraphNode(segment, []);
		this.nodeCache.set(segment, node);
		return node;
	}

	/**
	 * @return {[GraphNode, GraphNode]} 
	 * @memberof GraphGenerator
	 */
	createMarkerSet() {
		const id = /**@type {number}*/(this.idGenerator.next().value);
		const bof = new GraphNode(new ControlSegment({isBof: true, id}), []);
		const eof = new GraphNode(new ControlSegment({isBof: false, id}), []);

		return [bof, eof];
	}

	/**
	 * @static
	 * @yield {number}
	 * @return {Generator<number, number, number>}
	 * @memberof GraphGenerator
	 */
	static *IdGenerator() {
		let id = 0;
		while(true) yield id++;
		return id;
	}

	/**
	 * @static
	 * @param {GraphNode} graph
	 * @return {string} 
	 * @memberof GraphGenerator
	 */
	static __generateDotGraph(graph) {
		let dot = "digraph {\n";

		const nodes = new Set();
		const edges = new Map();

		/**
		 * @param {CommandSegment} segment
		 * @return {string} 
		 */
		function _stringifyCommandPart(segment) {
			if(!segment) return "invalid";

			if(segment instanceof KeywordSegment) {
				return `kw(${segment.name})`;
			} else if(segment instanceof VariableSegment) {
				return `var(${segment.name}, ${segment.type || "any"})`;
			} else if(segment instanceof ControlSegment && segment.isBof) {
				return `BOF-${segment.id}`;
			} else if(segment instanceof ControlSegment && !segment.isBof) {
				return `EOF-${segment.id}`;
			} else {
				return "unknown";
			}
		}

		/**
		 * @param {GraphNode} node
		 */
		function addNode(node) {
			if(nodes.has(node)) {
				return;
			}

			nodes.add(node);

			dot += `  "${_stringifyCommandPart(node.segment)}" [label="${_stringifyCommandPart(node.segment)}"];\n`;

			for(const edge of node.edges) {
				if(!edges.has(edge)) {
					edges.set(edge, new Set());
				}

				edges.get(edge).add(node);

				addNode(edge);
			}
		}

		addNode(graph);

		dot += "\n";

		for(const [edge, fromNodes] of edges) {
			for(const fromNode of fromNodes) {
				dot += `  "${_stringifyCommandPart(fromNode.segment)}" -> "${_stringifyCommandPart(edge.segment)}";\n`;
			}
		}

		dot += "}";

		return dot;
	}
}


class Command extends EventListener {
	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of Command.
	 * @param {string} name
	 * @param {CommandSegment[]} scheme
	 * @param {(event: CommandResult) => void} callback
	 * @param {string} [description]
	 * @memberof Command
	 */
	constructor(name, scheme, callback, description) {
		super();

		/**
		 * @type {
				EventListener["on"] &
				((event: "preview", listener: (event: JLEvent & CommandResult & {autocompleteTarget: string | null, preview: string | null}) => void) => JLListener)
			}
		 */
		// @ts-ignore
		this.on;

		/** @type {string} */
		this.name = name;

		/** @type {CommandSegment[]} */
		this.scheme = scheme;

		/** @type {Function} */
		this.callback = callback;

		const graphGenerator = new GraphGenerator();

		this.scheme.unshift(new KeywordSegment({name: this.name, comment: description || ""}));
		const [bof, eof] = graphGenerator.generateGraph(this.scheme);

		/** @type {GraphNode} */
		this.graph = bof;
	}

	toString() {
		return this.scheme.map(s => s.toString()).join(" ");
	}

	static ERROR =/**@type {const}*/({
		UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
		AMBIGUOUS_COMMAND: "AMBIGUOUS_COMMAND",
		INCOMPLETE_COMMAND: "INCOMPLETE_COMMAND",
	});
}

class CommandSegment {
	/**
	 * @typedef {Object} SegmentOptions
	 * @prop {string | undefined} [comment=""] 
	 */

	/**
	 * Creates an instance of Segment.
	 * @param {SegmentOptions} options
	 * @memberof Segment
	 */
	constructor(options) {
		/** @type {string} */
		this._type = "__unknown__";

		const {
			comment = "",
		} = options;

		/** @type {string} */
		this.comment = comment;
	}

	toString() {
		return "§7<§8...§7>";
	}
}

class ControlSegment extends CommandSegment {
	/**
	 * @typedef {Object} ControlSegmentOptions
	 * @prop {number} id
	 * @prop {boolean} [isBof=true]
	 */

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of ControlSegment.
	 * @param {ControlSegmentOptions & SegmentOptions} options
	 * @memberof ControlSegment
	 */
	constructor(options) {
		super(options);

		this._type = "control";

		const {
			id,
			isBof = true,
		} = options;

		/** @type {number} */
		this.id = id;

		/** @type {boolean} */
		this.isBof = isBof;
	}
}

class KeywordSegment extends CommandSegment {
	/**
	 * @typedef {Object} KeywordSegmentOptions
	 * @prop {string} name
	 */

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of KeywordSegment.
	 * @param {KeywordSegmentOptions & SegmentOptions} options
	 * @memberof KeywordSegment
	 */
	constructor(options) {
		super(options);

		this._type = "keyword";

		const {
			name
		} = options;

		/** @type {string} */
		this.name = name;

		if(!this.name) {
			throw new Error("Keyword name is required");
		}
	}

	toString() {
		return `§3${this.name}`;
	}
}

class VariableSegment extends CommandSegment {
	/**
	 * @typedef {Object} VariableSegmentOptions
	 * @prop {string} name
	 * @prop {"any" | "number" | "string" | "boolean" | "date" | "flag"} [type]
	 * @prop {any} [default]
	 * @prop {string[]} [enum]
	 * @prop {() => string[]} [provider]
	 * @prop {boolean} [isRest=false]
	 */

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of VariableSegment.
	 * @param {VariableSegmentOptions & SegmentOptions} options
	 * @memberof VariableSegment
	 */
	constructor(options) {
		super(options);

		this._type = "variable";

		const {
			name,
			type = undefined,
			default: _default = undefined,
			enum: _enum = undefined,
			provider = undefined,
			isRest = false
		} = options;

		/** @type {string} */
		this.name = name;

		/** @type {VariableSegmentOptions["type"] | undefined} */
		this.type = type;

		/** @type {string | undefined} */
		this.default = _default;

		/** @type {string[] | undefined} */
		this.enum = _enum && [...new Set(_enum)];

		/** @type {(() => string[]) | undefined} */
		this.provider = provider;

		/** @type {boolean} */
		this.isRest = isRest;

		/** @type {string[] | null} */
		this._provided_enum = null;

		if(!this.name) {
			throw new Error("Variable name is required");
		}

		const supportedTypes = ["any", "number", "string", "boolean", "date", "flag"];
		if(this.type && !supportedTypes.includes(this.type)) {
			throw new Error(`Unsupported variable type: ${this.type}`);
		}
	}

	toString() {
		const rest = this.isRest ? "..." : "";
		const colon = this.type || this.enum || this.provider ? "§8: " : "";
		const type = this.type ? `§5${this.type}` : this.enum ? this.enum.map(e => `§6"${e}"`).join(" §8| ") : this.provider ? "§2<provider>" : "";
		const comment = this.comment ? `§8; # ${this.comment}` : "";

		return `§7<§b${rest}${this.name}${colon}${type}${comment}§7>`;
	}

	/**
	 * @static
	 * @param {any} value
	 * @return {boolean} 
	 * @memberof VariableSegment
	 */
	static isNaN(value) {
		return value === "" || isNaN(value);
	}

	/**
	 * Compares value with type
	 * @static
	 * @param {string} value
	 * @param {VariableSegment} segment
	 * @returns {boolean}
	 * @memberof VariableSegment
	 */
	static compareType(value, segment) {
		const {type, name} = segment;

		if(type === "number") {
			return !this.isNaN(value);
		} else if(type === "string") {
			return true;
		} else if(type === "boolean") {
			return value === "true" || value === "false";
		} else if(type === "date") {
			return value !== "" && !this.isNaN(Date.parse(value));
		} else if(type === "flag") {
			return value === name;
		} else {
			return true;
		}
	}

	/**
	 * Tries to parse value as type
	 * @static
	 * @param {string} value
	 * @param {VariableSegment} segment
	 * @returns {string | number | boolean | Date}
	 * @memberof VariableSegment
	 */
	static parseValue(value, segment) {
		const {type} = segment;

		if(type === "number" && this.compareType(value, segment)) {
			return parseFloat(value);
		} else if(type === "boolean" && this.compareType(value, segment)) {
			return value === "true";
		} else if(type === "date" && this.compareType(value, segment)) {
			return new Date(value);
		} else if(type === "flag" && this.compareType(value, segment)) {
			return true;
		} else if(type === "string") {
			return value + "";
		} else {
			return value;
		}
	}
}

class OptionalSegment extends CommandSegment {
	/**
	 * @typedef {Object} OptionalSegmentOptions
	 * @prop {CommandSegment[]} segments
	 */

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of OptionalSegment.
	 * @param {OptionalSegmentOptions & SegmentOptions} options
	 * @memberof OptionalSegment
	 */
	constructor(options) {
		super(options);

		const {
			segments = []
		} = options;

		/** @type {CommandSegment[]} */
		this.segments = segments;
	}

	toString() {
		return `§7[${this.segments.map(s => s.toString()).join(" ")}§7]`;
	}
}

class UnionSegment extends CommandSegment {
	/**
	 * @typedef {Object} UnionSegmentOptions
	 * @prop {CommandSegment[][]} subSegments
	 */

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Creates an instance of UnionSegment.
	 * @param {UnionSegmentOptions & SegmentOptions} options
	 * @memberof UnionSegment
	 */
	constructor(options) {
		super(options);

		const {
			subSegments = []
		} = options;

		/** @type {CommandSegment[][]} */
		this.subSegments = subSegments;
	}

	toString() {
		return `§7(${this.subSegments.map(s => s.map(s => s.toString()).join(" ")).join(" §8| ")}§7)`;
	}
}

class CommandError extends Error {
	/**
	 * Creates an instance of CommandError.
	 * @param {string} message
	 * @param {string} code
	 * @memberof CommandError
	 */
	constructor(message, code) {
		super(message);

		/** @type {string} */
		this.name = "CommandError";

		/** @type {string} */
		this.code = code;
	}
}

// eslint-disable-next-line valid-jsdoc
/**
 * @param {string} name
 * @param {Omit<KeywordSegmentOptions, "name"> & SegmentOptions} [options]
 * @return {KeywordSegment} 
 */
function Keyword(name, options = {}) {
	return new KeywordSegment({
		name,
		...options
	});
}

// eslint-disable-next-line valid-jsdoc
/**
 * @param {string} name
 * @param {Omit<VariableSegmentOptions, "name"> & SegmentOptions} [options]
 * @return {KeywordSegment} 
 */
function Variable(name, options = {}) {
	return new VariableSegment({
		name,
		...options
	});
}

/**
 * @param {CommandSegment[]} segments
 * @return {OptionalSegment} 
 */
function Optional(segments) {
	return new OptionalSegment({
		segments
	});
}

/**
 * @param {(CommandSegment[])[]} subSegments
 * @return {UnionSegment} 
 */
function Union(subSegments) {
	return new UnionSegment({
		subSegments
	});
}

module.exports = {
	GraphNode,
	GraphGenerator,
	Command,
	CommandSegment,
	ControlSegment,
	KeywordSegment,
	VariableSegment,
	OptionalSegment,
	UnionSegment,
	CommandError,
	Keyword,
	Variable,
	Optional,
	Union
};