const http = require("http");
const path = require("path");
const util = require("util");
const url = require("url");
const fs = require("fs");
const {EventListenerStatic, EventListener, fixDigits, iterate, getQueryParameters} = require("./JustLib.js");
const {CLI, KEY} = require("./CLI");

const btoa = data => Buffer.from(data).toString("base64");
const atob = data => Buffer.from(data, "base64").toString();

const PATH = {
	CONFIG: __dirname + "/config.json",
	TRUSTED_IPS: __dirname + "/trustedips.json",
	BLACKLIST: __dirname + "/blacklist.json",
	MODULES: __dirname + "/modules/",
	PUBLIC: __dirname + "/public/"
};

//TODO: Replace status numbers with `Server.STATUS` enum

class Server extends EventListenerStatic {
	/**
	 * @typedef {Object} Credentials
	 * @prop {string} username
	 * @prop {string} password
	 */

	static title = null;
	static modules = {};
	/**
	 * Server standard input/output
	 * @static
	 * @type {{cli: CLI, settings: {logs: boolean, warnings: boolean, errors: boolean}}} obj1
	 * @memberof Server
	 */
	static stdio = {
		cli: null,
		settings: {
			logs: true,
			warnings: true,
			errors: true
		}
	};

	/**
	 * Controls logging of the unknown command error.
	 * In case you are using `input` event only on `Server.stdio.cli` (and not using `command` event),
	 * you may want to set this to `false`, so server won't show error every time you input something
	 * @type {boolean}
	 */
	static unknownCommandError = true;

	static TRUSTED_IPS = [];
	static BLACKLIST = [];
	static PATH = PATH;

	static isStopping = false;

	static begin() {
		/**
		 * @type {
				((event: string, listener: (event: RequestEvent) => void) => EventListener.Listener) &
				((event: 'request', listener: (event: RequestEvent) => void) => EventListener.Listener) &
				((event: 'load', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'unload', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: '404', listener: (event: RequestEvent) => void) => EventListener.Listener)
			}
		 */
		this.on;

		// const _originalListener = this.on;
		// this.on = (...args) => {
		// 	let type = args[0];
		// 	let middlewares = args[1];
		// 	let callback = args[2];

		// 	if(!callback && typeof middlewares === "function") callback = middlewares;
		// 	else if(callback && typeof middlewares === "function") middlewares = [middlewares];
		// 	else if(!callback) throw new TypeError("Invalid callback " + callback);
		// 	else if(!(middlewares instanceof Array)) throw new TypeError("Invalid middlewares: " + middlewares);

		// 	const listener = _originalListener(type, callback);
		// 	listener.middlewares = middlewares;
		// };

		//Set up error logging
		process.on("unhandledRejection", (reason, promise) => {
			this.error("Unhandled Promise Rejection at:", promise);
		});

		const startDate = new Date();
		this.log("§7Starting initialization...");

		//Config
		this.log("§7Loading properties...");
		this._loadConfig();
		this._loadTrustedIPs();
		this._loadBlacklist();
		this.log("§7Properties loaded");

		//CLI
		if(this.config["enable-cli"]) {
			this.log("§7Enabling CLI...");
			this.stdio.cli = new CLI(process);
			this.stdio.cli.begin();

			//Handle default commands
			this.stdio.cli.on("command", async e => {
				const {input, command, args} = e;

				if(command == "stop") {
					const isForced = args[0] == "force";
					this.stop(0, isForced);
				} else if(command == "help") {
					this.log("§eCommands:\n§bStop §f- §aStop server\n§bHelp §f- §aShow this menu");
				} else if(command == "clear") {
					console.clear();
				} else if(command == "ban") {
					const [ip] = args;
					const ipRegex = /((^\s*((([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))\s*$)|(^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$))/;

					if(ipRegex.test(ip)) {
						this.BLACKLIST.push(ip);
						this.log(`IP ${ip} has been banned`);
						this._saveBlacklist();
					} else this.log(`§c[ERROR]: Invalid IPv4 or IPv6 address`);
				} else if(command == "unban") {
					const [ip] = args;
					const index = this.BLACKLIST.indexOf(ip);

					if(index > -1) {
						this.BLACKLIST.splice(index, 1);
						this.log(`IP ${ip} has been unbanned`);
						this._saveBlacklist();
					} else this.log(`§c[ERROR]: Provided IP address is not banned`);
				} else if(command == "banlist") {
					this.log(`Blacklisted IPs(${this.BLACKLIST.length}):\n` + this.BLACKLIST.join("\n"));
				} else if(command == "eval") {
					try {
						e.preventDefault();
						this.log(util.formatWithOptions({colors: true}, "< %O", await eval(args.join(" "))));
					} catch(e) {
						this.log(`[EVAL ERROR]: ` + (e?.message || `Unknown error (${e?.message})`));
					}
				} else if(command == "exec") {
					const [filePath = "autoexec.cfg"] = args;

					fs.promises.readFile(path.join(__dirname, filePath)).catch(err => {
						this.log(`§c[ERROR]: ${err.message}`);
					}).then(file => {
						Server.log(`Executing ${filePath}...`);
						this.stdio.cli.sendInput(file.toString());
					});
				} else if(command == "") {

				} else return;

				e.preventDefault();
			});

			//Unknown command handler
			this.stdio.cli.on("unknownCommand", e => {
				if(e.defaultPrevented || !this.unknownCommandError) return;
				this.log("§cUnknown command. Write \"help\" for help.");
			});

			/*fs.writeFileSync("stdout.log", "");
			this.stdio.cli.on("stdout", ({string} = e) => {
				fs.appendFileSync("stdout.log", string);
			});*/
			this.log("§7CLI enabled");
		} else this.log(`§7CLI disabled`);

		//Init
		if(!this.title) this.setTitle();

		//Create HTTP server
		if(this.config["enable-http-server"]) {
			this.log("§7Creating HTTP server...");
			if(!fs.existsSync(PATH.PUBLIC)) {
				this.log(`§7Creating new empty §fpublic §7folder...`);
				fs.mkdirSync(PATH.PUBLIC);
			}
			this.http = http.createServer((req, res) => this._handleRequest(req, res));
			this.http.on("error", err => {
				this.error(err.message);
			});
			this.log(`§7HTTP server created`);
		} else this.log(`§6HTTP server is disabled!`);

		//Modules
		this._loadModules();

		//Load event
		this.log("§7Loading server...");
		this.dispatchEvent("load");
		this.log("§7Server loaded");

		//Make HTTP server listen for incoming requests
		if(this.config["enable-http-server"]) {
			this.http.listen(this.config["http-port"]);
			this.http.on("listening", e => {
				this.log("§7Server listen on port §f" + this.config["http-port"]);
				this.log(`§7Initialization done (§ftook ${new Date() - startDate}ms§7)`);
			});
		} else this.log(`§7Initialization done (§ftook ${new Date() - startDate}ms§7)`);
	}

	static stop(code = 0, force = false) {
		this.log("§cStopping server...");

		this.isStopping = true;
		this._saveBlacklist();

		this.dispatchEvent("unload", {forced: force, async: true}).then(() => {
			process.exit(code);
		});
	}

	static _handleRequest(req, res, redirectTo = null, prevEvent = null) {
		if(redirectTo && !prevEvent) throw new TypeError("Cannot redirect request if there is no RequestEvent provided");

		//TODO: Add error handling
		//TODO: Add error event (ability to send custom 500 Internal Server Error)
		const RemoteIP = req.connection.remoteAddress.split(":")[3];
		const ProxyIP = req.headers["x-forwarded-for"];
		const protocol = req.headers["x-forwarded-proto"] || `http${req.secure ? "s" : ""}`;
		const HOST = req.headers["host"];
		const IP = ProxyIP || RemoteIP;
		const URL = url.parse(req.url, true);
		const IS_TRUSTED = this.TRUSTED_IPS.map(e => IP.includes(e)).includes(true);
		const IS_BLACKLISTED = this.BLACKLIST.map(e => IP.includes(e)).includes(true);

		if(!redirectTo) {
			if(IS_TRUSTED) this.log(`§2Incoming request from ${HOST ? `§2(${HOST})` : ""}§2${RemoteIP}${ProxyIP ? `§3(${ProxyIP})` : ""}§2: §2${req.method} §2${req.url}`);
			else this.log(`§2Incoming request from ${HOST ? `§2(${HOST})` : ""}§a${RemoteIP}${ProxyIP ? `§b(${ProxyIP})` : ""}§2: §a${req.method} §a${req.url}`);

			if(IS_BLACKLISTED) {
				this.warn(`Received request from blacklisted IP (${IP})`);
				return Send(res, "403 Forbidden", 403);
			}
		}

		//Request handling
		let destinationPath = redirectTo || URL.pathname;

		/** @type {RequestEvent} */
		const EventObject = prevEvent || new RequestEvent({
			req,
			res,
			method: req.method,
			RemoteIP,
			ProxyIP,
			IP,
			host: (HOST || ""),
			HOST: (HOST || ""), /* Deprecated */
			origin: `${protocol}://${req.headers.host}`,
			protocol,
			path: destinationPath,
			Path: destinationPath, /* Deprecated */
			query: URL.query,
			IS_TRUSTED,
			defaultPreventable: true,
			autoPrevent: true,
			headers: req.headers,
			isRedirected: false,
			redirectChain: [destinationPath]
		});

		//Updated properties from previous request event
		if(redirectTo) {
			EventObject.redirectChain.push(destinationPath);
			EventObject.isRedirected = true;
			EventObject.path = destinationPath;
			EventObject.Path = destinationPath; /* Deprecated */

			//Reset `Event`'s internal properties
			EventObject.isStopped = false;
			EventObject.hasListener = false;
			EventObject.defaultPrevented = false;
		}

		//Fix destination path ending with "/"
		if(destinationPath.length > 1 && destinationPath.endsWith("/")) destinationPath = destinationPath.slice(0, -1);
		//if(destinationPath.length > 1 && destinationPath.endsWith("/")) EventObject.redirectURL(destinationPath.slice(0, -1), this.STATUS.REDIRECT.MOVED_PERMANENTLY);

		//Dispatch events
		this.dispatchEvent("request", EventObject);
		if(!EventObject.defaultPrevented) this.dispatchEvent(destinationPath, EventObject);

		//Dynamic destination path search
		const searchDispatched = [];
		for(const listener of this.listeners) {
			const type = listener.type;

			//Event was prevented
			if(EventObject.defaultPrevented) break;

			//Event was already dispatched
			if(searchDispatched.includes(type)) continue;

			//Create regex for each listener
			if(!("regex" in listener)) {
				if(["*", "?"].some(e => type.includes(e))) {
					listener.regex = new RegExp(type.replace(/(\.|\(|\)|\[|\]|\||\{|\}|\+|\^|\$|\/|\-|\\)/g, "\\$1").replace(/\?/g, "(.)").replace(/\*/g, "(.*)"), "i");
				} else {
					listener.regex = null;
					continue;
				}
			}

			//Listener uses dynamic representation of destination path
			if(listener.regex) {
				const match = destinationPath.match(listener.regex);

				//Destination path does not match required pattern
				if(!match) continue;

				//Add found matches to EventObject and dispatch event
				EventObject.matches = match.slice(1);
				this.dispatchEvent(type, EventObject);
				searchDispatched.push(type);
			}
		}

		//Default action
		if(!EventObject.defaultPrevented) {
			if(res.writableEnded) return this.warn(`Failed to write response after end. (Default action has not been prevented)`);

			try {
				EventObject.streamFile(path.join(PATH.PUBLIC, destinationPath.slice(1)));
			} catch(err) {
				this._handleNotFound(EventObject);
			}
		}
	}

	/**
	 *
	 * @static
	 * @param {RequestEvent} event
	 * @memberof Server
	 */
	static _handleNotFound(event) {
		this.dispatchEvent("404", event.clone(), () => {
			event.send("404 Not Found", 404);
		});
	}

	static readRangeHeader(req, totalLength) {
		const header = req.headers["range"];

		if(!header) return null;

		const array = header.split(/bytes=([0-9]*)-([0-9]*)/);
		const start = parseInt(array[1]);
		const end = parseInt(array[2]);
		const range = {
			start: isNaN(start) ? 0 : start,
			end: isNaN(end) ? (totalLength - 1) : end
		};

		if(!isNaN(start) && isNaN(end)) {
			range.start = start;
			range.end = totalLength - 1;
		}

		if(isNaN(start) && !isNaN(end)) {
			range.start = totalLength - end;
			range.end = totalLength - 1;
		}

		return range;
	}

	static _connectionLog(status) {
		this.log(`§8Connection closed (${status})`);
	}

	static _loadConfig() {
		this.log("§7Loading configuration...");
		const name = path.basename(PATH.CONFIG);

		//Create default
		if(!fs.existsSync(PATH.CONFIG)) {
			this.log(`§7Creating default §f${name} §7file...`);
			fs.writeFileSync(PATH.CONFIG, JSON.stringify(DEFAULT_CONFIG, null, "\t"));
		}

		//Get current config
		const config = JSON.parse(fs.readFileSync(PATH.CONFIG).toString());
		let changes = 0;

		//Get missing options
		for(const property in DEFAULT_CONFIG) {
			if(property in config) continue;
			config[property] = DEFAULT_CONFIG[property];
			changes++;
		}

		//Update config
		if(changes) {
			fs.writeFileSync(PATH.CONFIG, JSON.stringify(config, null, "\t"));
			this.log(`§7Added §f${changes} §7new options to §f${name}`);
		}

		//Apply config
		this.config = config;

		this.log("§7Configuration loaded");
	}

	static _loadModules() {
		this.log("§7Loading modules...");
		const dirname = path.basename(path.dirname(PATH.MODULES + " "));

		//Create default
		if(!fs.existsSync(PATH.MODULES)) {
			this.log(`§7Creating new empty §f${dirname} §7folder...`);
			fs.mkdirSync(PATH.MODULES);

			fs.writeFileSync(PATH.MODULES + "main.js", DEFAULT_MAIN);
		}

		//Load modules
		const files = getAllFiles(PATH.MODULES, 1);
		for(const file of files) {
			let project = path.basename(path.dirname(file)); if(project == dirname) project = null;
			const filename = path.basename(file);
			const moduleName = (project ? project + "/" : "") + filename;

			//Skip not '*.js' files
			if(fs.lstatSync(file).isDirectory() || !file.endsWith(".js")) continue;

			//Execute file
			try {
				this.modules[moduleName] = {
					loaded: true,
					exports: require(file)
				};
				this.log(`§7Loaded §f${project ? project + "§7:§f" : ""}${filename}`);
			} catch(e) {
				this.modules[moduleName] = {
					loaded: false,
					exports: undefined
				};
				this.error(`Failed to load '${filename}':`, e);
			}
		}

		this.log(`§7Loaded §f${Object.values(this.modules).filter(e => e.loaded).length}§7/§f${Object.values(this.modules).length} §7modules`);
	}

	static _loadTrustedIPs() {
		this.log("§7Loading trusted IPs...");
		const name = path.basename(PATH.TRUSTED_IPS);

		//Create default
		if(!fs.existsSync(PATH.TRUSTED_IPS)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.TRUSTED_IPS, `["localhost"]`);
		}

		//Apply Trusted IPs
		this.TRUSTED_IPS = JSON.parse(fs.readFileSync(PATH.TRUSTED_IPS));

		this.log(`§7Loaded §f${this.TRUSTED_IPS.length} §7trusted IPs`);
	}

	static _loadBlacklist() {
		this.log("§7Loading blacklist...");
		const name = path.basename(PATH.BLACKLIST);

		//Create default
		if(!fs.existsSync(PATH.BLACKLIST)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.BLACKLIST, `[]`);
		}

		//Apply Blacklist
		this.BLACKLIST = JSON.parse(fs.readFileSync(PATH.BLACKLIST));

		this.log(`§7Loaded §f${this.BLACKLIST.length} §7blacklisted IPs`);
	}

	static _saveBlacklist() {
		this.log("§7Saving blacklist...");
		const name = path.basename(PATH.BLACKLIST);

		//Create default
		if(!fs.existsSync(PATH.BLACKLIST)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.BLACKLIST, `[]`);
		}

		//Save blacklist
		fs.writeFileSync(PATH.BLACKLIST, JSON.stringify(this.BLACKLIST));

		this.log(`§7Saved §f${this.BLACKLIST.length} §7blacklisted IPs`);
	}

	static formatMessage(msg) {
		const codes = ["30", "34", "32", "36", "31", "35", "33", "37", "90", "94", "92", "96", "91", "95", "93", "97"];
		const message = (msg + "§r§7").replace(/§r/g, "\x1b[0m");

		const arr = message.split("§");
		let formatted = arr[0];

		if(arr.length > 1) {
			arr.shift();
			for(let i = 0; i < arr.length; i++) {
				const match = arr[i].match(/^[0-9a-f]/);

				if(match) formatted += `\x1b[${codes[parseInt(match[0], 16)]}m${arr[i].substr(1)}`;
				else continue;
			}
		} else {
			return message;
		}

		return formatted;
	}

	/**
	 * Formats array of any type into human readable, console printable string 
	 * @static
	 * @param {any[]} args
	 * @param {util.InspectOptions} options
	 * @returns {string}
	 * @memberof Server
	 */
	static formatArguments(args, options = {
		colors: true,
		depth: 4
	}) {
		const params = [];
		const format = args.map(arg => {
			if(typeof arg === "string") {
				if(options.colors) return this.formatMessage(arg);
				else return arg.replace(/§[0-9a-f]/g, "");
			} else {
				params.push(arg);
				return "%O";
			}
		}).join(" ");
		const message = util.formatWithOptions(options, format, ...params);

		return message;
	}

	static formatTime(d = new Date()) {
		return `[${fixDigits(d.getHours())}:${fixDigits(d.getMinutes())}:${fixDigits(d.getSeconds())}]`;
	}

	static setTitle(title = "Node.js Server - " + __filename) {
		this.title = title;
		(process.stdout.__write || process.stdout.write).apply(process.stdout, [`${String.fromCharCode(27)}]0;${title}${String.fromCharCode(7)}`]);
	}

	static log(...args) {
		if(!this.stdio.settings.logs) return false;

		const formattedArgs = this.formatArguments(args, {colors: true, depth: 4});
		const message = `${this.formatTime()} ${formattedArgs}`;
		console.log(message);
	}

	static warn(...args) {
		if(!this.stdio.settings.warnings) return false;

		const formattedArgs = this.formatArguments(args, {colors: false, depth: 4});
		const message = `\x1b[33m${this.formatTime()} [WARN]: ${formattedArgs}\x1b[0m`;
		console.warn(message);
	}

	static error(...args) {
		if(!this.stdio.settings.errors) return false;

		const formattedArgs = this.formatArguments(args, {colors: false, depth: 4});
		const message = `\x1b[31m${this.formatTime()} [ERROR]: ${formattedArgs}\x1b[0m`;
		console.error(message);
	}
}

/**
 *
 * @class RequestEvent
 * @extends {EventListener.Event}
 */
class RequestEvent extends EventListener.Event {
	/**
	 * @typedef {(event: RequestEvent, next: Function) => void} MiddlewareCallback
	 */

	/**
	 * @typedef {(query: Object<string, string>) => void} RequestCallbackGET
	 */

	/**
	 * @typedef {
			((callback: RequestCallbackGET) => boolean) &
			((middleware: MiddlewareCallback, callback: RequestCallbackGET) => boolean) &
			((middlewares: MiddlewareCallback[], callback: RequestCallbackGET) => boolean)
		} RequestHandlerGET
	 */

	constructor(data) {
		super(data);


		/**
		 * @type {http.IncomingMessage} Request object
		 */
		this.req;

		/**
		 * @type {http.ServerResponse} Response object
		 */
		this.res;

		/**
		 * @type {string} Request method
		 */
		this.method;

		/**
		 * @type {string} Remote IP address
		 */
		this.RemoteIP;

		/**
		 * @type {string} Forwarded IP address
		 */
		this.ProxyIP;

		/**
		 * @type {string} IP address of the client
		 */
		this.IP;

		/**
		 * @type {string} Request host
		 */
		this.host;

		/**
		 * @deprecated Use 'host' instead
		 * @type {string} Request host
		 */
		this.HOST;

		/**
		 * @type {string} Request protocol
		 * @example "http" or "https"
		 */
		this.protocol;

		/**
		 * @type {string} Request origin
		 * @example "https://www.example.com"
		 */
		this.origin;

		/**
		 * @type {string} Request destination path
		 */
		this.path;

		/**
		 * @deprecated Use 'path' instead
		 * @type {string} Request destination path
		 */
		this.Path;

		/**
		 * @type {Object<string, string>} Request query string parameters object
		 */
		this.query;

		/**
		 * @type {boolean} Tells if the request comes from trusted origin
		 */
		this.IS_TRUSTED;

		/**
		 * @type {boolean} Enables auto prevent when calling methods 'get', 'post', 'send', 'sendFile', 'streamFile'...
		 */
		this.autoPrevent;

		/**
		 * @type {string[]} Array of matches, if wildcard handler was used
		 */
		this.matches;

		/**
		 * @type {http.IncomingHttpHeaders} HTTP headers sent by the client
		 */
		this.headers;

		/**
		 * @type {boolean} Determines if the request was redirected
		 */
		this.isRedirected;

		/**
		 * @type {string[]} Array of redirected paths
		 */
		this.redirectChain;

		/**
		 * @type {boolean} `true` if the request body was successfully received and parsed
		 */
		this.isBodyReceived = false;

		/**
		 * @type {Buffer} Received body raw buffer
		 */
		this.bodyRaw = undefined;

		/**
		 * @type {any} Parsed body data
		 */
		this.body = undefined;

		/**
		 * @type {Object<string, any>} Represents custom data object. Could be used in the middlewares to transfer data into event handlers.
		 */
		this.data = {};


		/**
		 * Handles GET method
		 * @returns {boolean} True if request was successfully handled, otherwise false
		 * @type {RequestHandlerGET}
		*/
		this.get = this.__get;
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @private
	 */
	__get(middlewares, callback = null) {
		if(!callback && typeof middlewares === "function") { // f(callback)
			callback = middlewares;
			middlewares = [];
		}
		else if(callback && typeof middlewares === "function") middlewares = [middlewares]; // f(middleware, callback)
		else if(!callback) throw new TypeError("'callback' parameter is not type of function");
		else if(!(middlewares instanceof Array)) throw new TypeError("'middlewares' parameter is not type of function[]");

		const executor = (middlewares, i = 0) => {
			return () => {
				if(i == middlewares.length) callback(this);
				else middlewares[i](this, executor(middlewares, i + 1));
			};
		};

		if(this.req.method == "GET") {
			if(this.autoPrevent) this.defaultPrevented = true;

			if(!middlewares.length) callback(this.query);
			else executor(middlewares)();

			return true;
		} else return false;
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Handles POST method
	 * @param {(bodyParsed: string | Object<string, any>, bodyBuffer: Buffer) => void} callback Request callback function
	 * @param {"text" | "json" | "form" | "raw"} [type] Request body type (Default: depending on `content-type` header)
	 * @returns {boolean} True if request was successfully handled, otherwise false
	 * @memberof RequestEvent
	 */
	post(callback, type) {
		if(typeof callback !== "function") throw new TypeError("'callback' parameter is not type of function");

		if(!type) {
			const contentType = this.headers["content-type"] || "";

			if(contentType.indexOf("application/json") != -1) type = "json";
			else if(contentType.indexOf("application/x-www-form-urlencoded") != -1) type = "form";
			else if(contentType.indexOf("text") != -1) type = "text";
			else type = "raw";
		}

		if(this.req.method == "POST") {
			if(this.autoPrevent) this.defaultPrevented = true;

			if(this.isBodyReceived) {
				callback(this.body, this.bodyRaw);
			}

			const chunks = [];

			this.req.on("data", chunk => {
				chunks.push(chunk);
			});

			this.req.on("end", () => {
				const buffer = Buffer.concat(chunks);
				let body = undefined;

				if(type == "json") {
					try {
						body = JSON.parse(buffer.toString());
					} catch(e) {
						body = null;
					}
				} else if(type == "form") {
					body = getQueryParameters(buffer.toString());
				} else if(type == "text") {
					body = buffer.toString();
				} else if(type == "raw") {
					body = buffer;
				} else {
					throw new TypeError(`'${type}' is invalid content type`);
				}

				this.body = body;
				this.bodyRaw = buffer;
				this.isBodyReceived = true;

				callback(body, buffer);
			});

			return true;
		} else return false;
	}

	//TODO: Add more methods

	/**
	 * Redirects destination path to another local path
	 * @example Server.on("/home", e => {
	 * e.redirect("/home.html");
	 * });
	 * @param {string} destination
	 * @memberof RequestEvent
	 */
	//TODO: Rename to `redirectRequest`
	redirect(destination) {
		if(typeof destination !== "string") throw new TypeError("'destination' parameter is not type of string");

		this.preventDefault();
		this.stopPropagation();

		Server._handleRequest(this.req, this.res, destination, this);
	}

	/**
	 * Redirects destination path to another local path
	 * @example Server.on("/instagram", e => {
	 * e.redirectURL("https://www.instagram.com/example");
	 * });
	 * @example Server.on("/dashboard", e => {
	 * e.redirectURL("/login");  //This will get converted to absolute path internally
	 * });
	 * @param {string} destination
	 * @param {number} [status=307]
	 * @memberof RequestEvent
	 */
	//TODO: Rename to `redirect`
	redirectURL(destination, status = 307) {
		if(typeof destination !== "string") throw new TypeError("'destination' parameter is not type of string");

		if(destination.startsWith("/")) destination = this.origin + destination;

		this.preventDefault();
		this.res.writeHead(status, {"Location": destination});
		this.res.end();
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * Authentication
	 * @param {((credentials: Credentials) => void) | null | false} callback  If `false` no login is required, otherwise the user will be prompted with login popup (if the login will be required)
	 * @param {string} [realm="realm"] Set when dealing with multiple login sessions
	 * @param {Credentials} [credentials=Server.config.login] Use custom `Credentials` object (default is `login` field in server config file)
	 * @returns {boolean} `true` if the user is logged in, otherwise `false`
	 * @memberof RequestEvent
	 */
	auth(callback = null, realm = "realm", credentials = Server.config.login) {
		const auth = this.req.headers.authorization;
		const basic = auth?.match(/Basic ([A-Za-z0-9+\/]*)/)?.[1];
		const bearer = auth?.match(/Bearer ([A-Za-z0-9+\/=\-_.~]*)/)?.[1];

		const forceLogin = callback !== false;
		const hasCallback = forceLogin && callback !== null;

		//Handle callback type
		if(hasCallback && typeof callback !== "function") throw new TypeError(`Callback '${callback}' is not type of function or null`);

		//No auth header
		if(!auth && (!basic || !bearer)) {
			if(forceLogin) this.send("", 401, "text/html", {"www-authenticate": `Basic realm="${realm}"`});
			return false;
		}

		//Bearer auth
		if(typeof credentials.token !== "undefined") {
			//Check access
			if(bearer == credentials.token) {
				Server.log(`§eToken '${bearer}' just used!`);
				if(hasCallback) callback(credentials);
				return true;
			} else {
				Server.log(`§eInvalid token attempt '${bearer}'!`);
				if(forceLogin) this.send("401 Unauthorized", 401);
				return false;
			}
		}

		//Basic auth
		if(typeof credentials.username !== "undefined" && typeof credentials.password !== "undefined") {
			//Decode credentials
			try {
				var [username, password] = atob(basic).split(":");
			} catch(e) {
				Server.error(e);

				this.send("500 Error occurred while decoding credentials", 401);
				return false;
			}

			//Check access
			if(username == credentials.username && password == credentials.password) {
				Server.log(`§eUser '${username}' just logged in!`);
				if(hasCallback) callback(credentials);
				return true;
			} else {
				Server.log(`§eUnsuccessful login attempt '${username}:${password}'!`);
				if(forceLogin) this.send("401 Unauthorized", 401);
				return false;
			}
		}

		//Unsupported auth
		this.send("500 Cannot process provided authentication type", 500);
		throw new TypeError("Invalid credentials / unsupported authentication type", credentials, auth);
	}

	/**
	 * Send response (shorthand for 'Send')
	 * @param {string | Object<string, any> | Buffer | ReadableStream} data Data to be sent as response
	 * @param {number} [status=200] Response status code
	 * @param {string | "text/plain" | "text/html" | "application/json" | "image/png" | "audio/mpeg" | "video/mp4"} [contentType="text/plain"] Content type of the response
	 * @param {http.OutgoingHttpHeaders} [headers={}] Response headers
	 */
	send(data, status = 200, contentType = "text/plain", headers = {}) {
		this.preventDefault();

		if(!this.res.writableEnded) {
			//Send data
			//TODO: Move `Send` content here
			//TODO: Switch from calling `Send` to calling `this.send` in internal methods
			Send(this.res, data, status, contentType, headers);
			Server._connectionLog(status);
		} else Server.warn(`Failed to write response after end. ('e.send()'/'e.streamFile()' might be called multiple times)`);
		//TODO: Add more info to the warning (create separate method + include stack trace)
	}

	/**
	 * @typedef {Object} SendOptions
	 * @prop {string | Object<string, any> | Buffer | ReadableStream} data 
	 * @prop {number} [status=200] 
	 * @prop {string} [contentType="text/plain"] 
	 * @prop {http.OutgoingHttpHeaders} [headers={}] 
	 */

	/**
	 * Equivalent of `RequestEvent.send` but with single parameter - an object of options
	 * @param {SendOptions} options
	 * @memberof RequestEvent
	 */
	sendOptions(options) {
		const {
			data,
			status = 200,
			contentType = "text/plain",
			headers = {}
		} = options;
		this.send(data, status, contentType, headers);
	}

	/**
	 * Stream file buffer
	 * @param {string} filePath
	 * @param {number} [status=200]
	 * @param {http.OutgoingHttpHeaders} [headers={}]
	 * @returns {Promise<boolean>}
	 * @memberof RequestEvent
	 */
	async sendFile(filePath, status = 200, headers = {}) {
		this.preventDefault();
		if(this.res.writableEnded) return Server.warn(`Failed to write response after end. ('e.send()'/'e.streamFile()' might be called multiple times)`);

		const stat = await fs.promises.stat(filePath).catch(() => { });
		if(!stat || stat.isDirectory()) {
			Server._handleNotFound(this);
			return false;
		}

		headers["Content-Length"] = stat.size;

		//Send file
		Send(this.res, fs.createReadStream(filePath), status, getContentType(filePath), headers);
		Server._connectionLog(status);
		return true;
	}

	/**
	 * Stream file using partial content response
	 * @param {string} filePath
	 * @param {http.OutgoingHttpHeaders} [headers={}]
	 * @returns {Promise<boolean>}
	 * @memberof RequestEvent
	 */
	async streamFile(filePath, headers = {}) {
		this.preventDefault();
		if(this.res.writableEnded) return Server.warn(`Failed to write response after end. ('e.send()'/'e.streamFile()' might be called multiple times)`), false;

		let status = 0;
		const contentType = getContentType(filePath);
		const stat = await fs.promises.stat(filePath).catch(() => { });
		if(!stat || stat.isDirectory()) {
			Server._handleNotFound(this);
			return false;
		}

		const range = Server.readRangeHeader(this.req, stat.size);

		if(!range) {
			headers["Content-Length"] = stat.size;
			Send(this.res, fs.createReadStream(filePath), status = 200, contentType, headers), Server._connectionLog(status);
			return true;
		}

		//Request cannot be fulfilled due to incorrect range
		if(range.start >= stat.size || range.end >= stat.size) {
			//Send correct range
			headers["Content-Range"] = `bytes */${stat.size}`;
			Send(this.res, "416 Range Not Satisfiable", status = 416, contentType, headers);
		} else {
			//Set up headers
			headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
			headers["Content-Length"] = range.start == range.end ? 0 : (range.end - range.start + 1);
			headers["Accept-Ranges"] = "bytes";
			//headers["Cache-Control"] = "no-cache";

			//Send part of file
			Send(this.res, fs.createReadStream(filePath, range), status = 206, contentType, headers);
		}
		Server._connectionLog(status);
		return true;
	}

	/**
	 * Set header to be sent with response
	 * @param {string} name
	 * @param {number | string | ReadonlyArray<string>} value
	 * @memberof RequestEvent
	 */
	setHeader(name, value) {
		this.res.setHeader(name, value);
	}

	/**
	 * Clones current RequestEvent object and creates new one
	 * @return {RequestEvent} 
	 * @memberof RequestEvent
	 */
	clone() {
		const event = new RequestEvent(this);
		event.reset();

		return event;
	}
}


class CookieJar {
	constructor() {
		/**
		 * @type {CookieJar.Cookie[]}
		 */
		this.cookies = [];

		if(arguments.length) this.setCookie.apply(this, arguments);
	}

	/**
	 * Adds cookie to the Jar
	 * @param {string|CookieJar.Cookie|http.ServerResponse} cookie Cookie name (requires second parameter), Cookie String, CookieJar.Cookie object, ServerResponseLike object
	 * @param {string} [value=undefined]
	 * @param {Object<string,any>} [options={}]
	 * @returns {CookieJar}
	 * @memberof CookieJar
	 */
	setCookie(cookie, value = undefined, options = {}) {
		//Set by name=value
		if(typeof value !== "undefined") {
			const _cookie = new CookieJar.Cookie();
			_cookie.name = cookie.trim();
			_cookie.value = (value ?? "").trim();

			for(const [i, key, value] of iterate(options)) {
				if(value == true) _cookie.flags.push(key);
				else if(value == false) _cookie.flags.splice(_cookie.flags.indexOf(key), 1);
				else _cookie.props[CookieJar.Cookie.formatKeyword(key) || key] = value;
			}

			this._addCookiesToJar(_cookie);
			return this;
		}

		//Set by Cookie object
		if(cookie instanceof CookieJar.Cookie) {
			this._addCookiesToJar(cookie);
			return this;
		}

		if(typeof cookie == "object") {
			const cookieString = cookie?.headers?.cookie;
			const header = cookie?.headers?.raw?.()?.["set-cookie"];
			const jsonObject = Object.keys(cookie) == "cookies" ? cookie.cookies : null;

			//Set by Request object
			if(cookieString) {
				const cookieStringArray = cookieString.split(";");
				const cookies = CookieJar.Cookie.parse(cookieStringArray);
				this._addCookiesToJar(...cookies);
			}

			//Set by Response object
			if(header) {
				const cookies = CookieJar.Cookie.parse(header);
				this._addCookiesToJar(...cookies);
			}

			//Set by JSON object
			if(jsonObject) {
				for(const cookieObject of jsonObject) {
					const _cookie = new CookieJar.Cookie();
					_cookie.name = cookieObject.name;
					_cookie.value = cookieObject.value;
					_cookie.props = cookieObject.props;
					_cookie.flags = cookieObject.flags;
					this._addCookiesToJar(_cookie);
				}
			}
			return this;
		}

		//TODO: Set by cookie string

		throw new TypeError("Cannot set cookie: " + cookie);
	}

	/**
	 * Returns cookie object found by name
	 * @param {string} name Cookie name
	 * @returns {CookieJar.Cookie} Cookie object if found, otherwise undefined
	 * @memberof CookieJar
	 */
	getCookie(name) {
		this._removeExpiredCookies();
		return this.cookies.find(cookie => cookie.name == name);
	}

	/**
	 * Removes cookie from the Jar
	 * @param {string|CookieJar.Cookie} cookie
	 * @returns {CookieJar.Cookie} Deleted cookie
	 * @memberof CookieJar
	 */
	deleteCookie(cookie) {
		let _cookie = null;
		if(typeof cookie === "string") _cookie = this.getCookie(cookie);
		else if(cookie instanceof CookieJar.Cookie) _cookie = cookie;
		else throw new TypeError("Invalid cookie: " + cookie);

		const id = this.cookies.indexOf(_cookie);
		if(id < 0 || !_cookie) return false;
		else this.cookies.splice(id, 1);
		return _cookie;
	}

	/**
	 * Sends header with cookies
	 * @param {http.ServerResponse} response Server response object
	 * @param {boolean} [full=true] Include cookie properties and flags
	 * @returns {CookieJar.Cookie}
	 * @memberof CookieJar
	 */
	sendCookies(response, full = true) {
		this._removeExpiredCookies();
		response.setHeader("Set-Cookie", this.cookies.map(e => e.toString(full)));
		return this;
	}

	/**
	 * Converts Cookie object to cookie string
	 * @param {boolean} [full=true] Include cookie properties and flags
	 * @returns {string} Cookie String
	 * @memberof CookieJar
	 */
	toString(full = true) {
		this._removeExpiredCookies();
		return this.cookies.map(e => e.toString(full)).join("");
	}

	/**
	 * Checks if the Jar is empty
	 * @returns {boolean} true if Jar is empty, otherwise false
	 * @memberof CookieJar
	 */
	isEmpty() {
		this._removeExpiredCookies();
		return this.cookies.length == 0;
	}

	/**
	 * Checks if the Jar contains cookie with certain name
	 * @param {string} name Cookie name
	 * @returns {boolean} true if Jar contains cookie with certain name, otherwise false
	 * @memberof CookieJar
	 */
	includes(name) {
		this._removeExpiredCookies();
		return !!this.getCookie(name);
	}

	/**
	 * Adds cookies to the Jar
	 * @param {CookieJar.Cookie} cookies
	 * @memberof CookieJar
	 */
	_addCookiesToJar(...cookies) {
		for(const cookie of cookies) {
			this.deleteCookie(cookie.name);
			this.cookies.push(cookie);
		}
		this._removeExpiredCookies();
	}

	/**
	 * Removes expired cookies from the Jar
	 * @memberof CookieJar
	 */
	_removeExpiredCookies() {
		for(const cookie of this.cookies) {
			if(cookie.props["Expires"] && new Date(cookie.props["Expires"]) < new Date()) this.deleteCookie(cookie);
		}
	}
}

/**
 * @typedef {Object} Cookie
 */
CookieJar.Cookie = class Cookie {
	/**
	 * @typedef {Object} CookieProperties
	 * @prop {string} [Expires] The maximum lifetime of the cookie as an HTTP-date timestamp.
	 * @prop {string} [Max-Age] Number of seconds until the cookie expires. A zero or negative number will expire the cookie immediately.
	 * @prop {string} [Domain] Host to which the cookie will be sent.
	 * @prop {string} [Path] A path that must exist in the requested URL, or the browser won't send the `Cookie` header.
	 * @prop {string} [SameSite] Controls whether a cookie is sent with cross-origin requests, providing some protection against cross-site request forgery attacks (CSRF).
	 */

	constructor() {
		this.name = "";
		this.value = "";

		/**
		 * @type {CookieProperties}
		 */
		this.props = {};

		/**
		 * @type {Array<"Secure"|"HttpOnly">}
		 */
		this.flags = [];
	}

	/**
	 * Convert cookie to cookie string
	 * @param {boolean} [full=true] Include cookie properties and flags
	 * @returns {string} Cookie String
	 */
	toString(full = true) {
		const head = `${this.name}=${this.value}; `;
		const props = this.props.reduce((prev, {key, value}) => prev + `${key}=${value}; `, "");
		const flags = this.flags.join("; ");

		return full ? `${head}${props}${flags ? `${flags}; ` : ""}` : head;
	}

	static keywords = ["Expires", "Max-Age", "Domain", "Path", "Secure", "HttpOnly", "SameSite"];
	static formatKeyword(key) {
		for(const keyword of this.keywords) {
			if(keyword.toLowerCase() == key.toLowerCase()) return keyword;
		}
		return false;
	}

	static parse(cookieStringArray) {
		return cookieStringArray.map(cookieString => {
			const cookie = new CookieJar.Cookie();
			const properties = cookieString.split(/;\s*/);

			for(const property of properties) {
				if(!property) continue;

				const {key, value, flag} = property.match(/(?:(?<key>.*?)=(?<value>.*)|(?<flag>.*))/)?.groups || {};

				if(key) {
					if(!cookie.name && !cookie.value) {
						cookie.name = key.trim();
						cookie.value = value.trim();
					} else {
						cookie.props[this.formatKeyword(key) || key] = value;
					}
				} else if(flag) {
					cookie.flags.push(flag);
				} else {
					//throw new TypeError("Failed to parse cookie: '" + property + "'");
					Server.warn("Failed to parse cookie: '" + property + "'");
				}
			}

			return cookie;
		});
	}
};

const DEFAULT_CONFIG = {
	"http-port": 80,
	"enable-http-server": true,
	"enable-cli": true,
	"debug": true,
	"login": {
		"username": "admin",
		"password": "admin"
	}
};

const DEFAULT_MAIN = `const {Server, CookieJar} = require("../server.js");

//Handle load event
Server.on("load", e => {
	Server.log("§aThis is my colored message!");

	//Using server CLI
	Server.stdio.cli.on("command", cmd => {
		//'input' is whole input
		//'command' is issued command
		//'args' is array of command arguments
		const {input, command, args} = cmd;

		//'say' command
		if(command == "say") {
			Server.log("You just said: " + input);
		}
		//'info' command
		else if(command == "info") {
			Server.log("You issued", command, "command with", args.length, "arguments, all together as:", input);
		}
		//This is not our command, just ignore it
		else return;

		//Remember to always prevent default action of the event,
		//otherwise 'unknownCommand' event will be fired!
		e.preventDefault();
	});
});

//Root handler
Server.on("/", e => {
	e.send("Hello World, from the server!");
});

//Handle simple request
Server.on("/hello", e => {
	e.send("Hey!");
});

//Handle 404 Not Found
Server.on("404", e => {
	e.send("There's nothing you see here :(");
});

//Handle dynamic request
//There are two special characters available:
//'*' - extends to /(.*)/ regex (matches 0 or more characters)
//'?' - extends to /(.)/ regex (matches 1 character)
//Example: let's say we want format like this: '/user/<user>/<page>' => '/user/john123/profile'
Server.on("/user/*/*", e => {
	//e.matches contains ordered matches from requested url
	//get 'user' and 'page' from matched url
	const [user, page] = e.matches;

	if(page == "profile") {
		//Send user their profile page
		e.send("Welcome back " + user);
	} else if(page == "settings") {
		//do more stuff...
	}

	//If no response was sent, the 404 status will be sent
});

//Redirect request to another path
Server.on("/home", e => {
	//Since there is no "/home.html" handler this will
	//respond with file "/public/home.html" (if it exists)
	e.redirect("/home.html");
});

//Handle different request methods
Server.on("/request", e => {
	//Handle GET method
	e.get(query => {
		e.send("GET: Your sent query string: " + JSON.stringify(query));
	});

	//Handle POST method
	e.post(body => {
		e.send("POST: Your sent data: " + body);
	});

	//POST requests may have defined (second parameter of the post function) body data type (json or form),
	//those will get parsed into JSON object.
	//Second parameter of the callback is body buffer
	// e.post((body, buffer) => {
	// 	e.send("POST: Your sent data parsed as JSON: " + JSON.stringify(body));
	// }, "json");
});

//Advanced request handling
Server.on("/request", e => {
	//Get values from event object
	const {req, res, method} = e;

	//Get cookies from request object
	const cookies = new CookieJar(req);

	//If there is no 'session' cookie, send error with 401 status code
	if(!cookies.getCookie("session") && method == "GET")
		return e.send("Error: You do not have session token yet! Send POST request to get one!", 401);

	//Handle GET method
	e.get(query => {
		//Get value of 'session' cookie
		const session = cookies.getCookie("session").value;

		//Check database if the session token is valid
		if(session == "T0yS2KoavK59Xy5y7YXc87nQ") {
			//Send successful response
			e.send("GET: Congratulations! You have logged in!");
		} else {
			//Send unsuccessful response
			e.send("GET: Your session token is invalid! Try to log in!", 401);
		}
	});

	//Handle POST method
	e.post(body => {
		//Generate new session token cookie and add it to cookie jar
		//Note: This will overwrite the original value
		cookies.setCookie("session", "T0yS2KoavK59Xy5y7YXc87nQ");

		//Send updated cookies
		cookies.send(res);

		//Send successful response
		e.send("POST: Your new session token has been generated! You can log in now!" + body);
	});
});`;

const CONTENT_TYPES = {
	"aac": "audio/aac",
	"avi": "video/x-msvideo",
	"bin": "application/octet-stream",
	"bmp": "image/bmp",
	"bz": "application/x-bzip",
	"bz2": "application/x-bzip2",
	"csh": "application/x-csh",
	"css": "text/css",
	"csv": "text/csv",
	"doc": "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"eot": "application/vnd.ms-fontobject",
	"gz": "application/gzip",
	"gif": "image/gif",
	"html": "text/html",
	"htm": "text/html",
	"ico": "image/vnd.microsoft.icon",
	"ics": "text/calendar",
	"jar": "application/java-archive",
	"jpg": "image/jpeg",
	"jpeg": "image/jpeg",
	"js": "text/javascript",
	"json": "application/json",
	"mid": "audio/midi",
	"midi": "audio/midi",
	"mjs": "text/javascript",
	"mp3": "audio/mpeg",
	"mp4": "video/mp4",
	"mpeg": "video/mpeg",
	"mpkg": "application/vnd.apple.installer+xml",
	"oga": "audio/ogg",
	"ogv": "video/ogg",
	"ogx": "application/ogg",
	"otf": "font/otf",
	"png": "image/png",
	"pdf": "application/pdf",
	"php": "application/x-httpd-php",
	"ppt": "application/vnd.ms-powerpoint",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"rar": "application/vnd.rar",
	"rtf": "application/rtf",
	"sh": "application/x-sh",
	"svg": "image/svg+xml",
	"tar": "application/x-tar",
	"tif": "image/tiff",
	"tiff": "image/tiff",
	"ts": "video/mp2t",
	"ttf": "font/ttf",
	"txt": "text/plain",
	"wav": "audio/wav",
	"webm": "audio/webm",
	"weba": "video/webm",
	"webp": "image/webp",
	"woff": "font/woff",
	"woff2": "font/woff2",
	"xhtml": "application/xhtml+xml",
	"xls": "application/vnd.ms-excel",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"xml": "application/xml",
	"zip": "application/zip",
	"7z": "application/x-7z-compressed"
};
Server.CONTENT_TYPES = CONTENT_TYPES;

const STATUS = {
	INFO: {
		CONTINUE: 100,
		SWITCHING_PROTOCOLS: 101,
		PROCESSING: 102,
		EARLY_HINTS: 103
	},
	SUCCESS: {
		OK: 200,
		CREATED: 201,
		ACCEPTED: 202,
		NON_AUTHORITATIVE_INFORMATION: 203,
		NO_CONTENT: 204,
		RESET_CONTENT: 205,
		PARTIAL_CONTENT: 206,
		MULTI_STATUS: 207,
		ALREADY_REPORTED: 208,
		IM_USED: 226
	},
	REDIRECT: {
		MULTIPLE_CHOICES: 300,
		MOVED_PERMANENTLY: 301,
		FOUND: 302,
		SEE_OTHER: 303,
		NOT_MODIFIED: 304,
		USE_PROXY: 305,
		UNUSED: 306,
		TEMPORARY_REDIRECT: 307,
		PERMANENT_REDIRECT: 308
	},
	CLIENT: {
		BAD_REQUEST: 400,
		UNAUTHORIZED: 401,
		PAYMENT_REQUIRED: 402,
		FORBIDDEN: 403,
		NOT_FOUND: 404,
		METHOD_NOT_ALLOWED: 405,
		NOT_ACCEPTABLE: 406,
		PROXY_AUTHENTICATION_REQUIRED: 407,
		REQUEST_TIMEOUT: 408,
		CONFLICT: 409,
		GONE: 410,
		LENGTH_REQUIRED: 411,
		PRECONDITION_FAILED: 412,
		PAYLOAD_TOO_LARGE: 413,
		URI_TOO_LONG: 414,
		UNSUPPORTED_MEDIA_TYPE: 415,
		RANGE_NOT_SATISFIABLE: 416,
		EXPECTATION_FAILED: 417,
		IM_A_TEAPOT: 418,
		MISDIRECTED_REQUEST: 421,
		UNPROCESSABLE_ENTITY: 422,
		LOCKED: 423,
		FAILED_DEPENDENCY: 424,
		TOO_EARLY: 425,
		UPGRADE_REQUIRED: 426,
		PRECONDITION_REQUIRED: 428,
		TOO_MANY_REQUESTS: 429,
		REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
		UNAVAILABLE_FOR_LEGAL_REASONS: 451
	},
	SERVER: {
		INTERNAL_SERVER_ERROR: 500,
		NOT_IMPLEMENTED: 501,
		BAD_GATEWAY: 502,
		SERVICE_UNAVAILABLE: 503,
		GATEWAY_TIMEOUT: 504,
		HTTP_VERSION_NOT_SUPPORTED: 505,
		VARIANT_ALSO_NEGOTIATES: 506,
		INSUFFICIENT_STORAGE: 507,
		LOOP_DETECTED: 508,
		NOT_EXTENDED: 510,
		NETWORK_AUTHENTICATION_REQUIRED: 511
	}
};
Server.STATUS = STATUS;

/* Helper Functions */
function readFileAsync(path, ...options) {
	return new Promise((resolve, reject) => {
		fs.readFile(path, ...options, function(error, data) {
			if(error) reject(error);
			else resolve(data);
		});
	});
}

function writeFileAsync(path, data, ...options) {
	return new Promise((resolve, reject) => {
		fs.writeFile(path, data, ...options, function(error) {
			if(error) reject(error);
			else resolve();
		});
	});
}

function Send(res, data, status = 200, type = "text/plain", headers = {}) {
	const isObject = typeof data === "object";
	const isBuffer = data instanceof Buffer;
	const isStream = !!data.pipe;

	res.writeHead(status, {
		"Content-Type": (isBuffer || isStream) ? type : (isObject ? "application/json" : type),
		...headers
	});
	if(isStream) {
		data.pipe(res);
	} else {
		res.write(isBuffer ? data : (isObject ? JSON.stringify(data) : data + ""));
		res.end();
	}
}

async function editJSON(path, callback = null) {
	var json = JSON.parse(await readFileAsync(path));
	if(typeof callback === "function") {
		var newJson = callback(json);
		await writeFileAsync(path, JSON.stringify(newJson));
		return newJson;
	} else return json;
}

function getContentType(filename, mismatch = "text/plain") {
	return CONTENT_TYPES[filename.match(/\.(\w+)$/mi)?.[1]] || mismatch;
}

function getFileFormat(contentType, mismatch = "") {
	return Object.keys(CONTENT_TYPES).find(key => CONTENT_TYPES[key] == contentType) || mismatch;
}

function getAllFiles(dirPath, depth = Infinity, i = 0, arrayOfFiles = []) {
	if(i > depth) return arrayOfFiles;

	files = fs.readdirSync(dirPath);

	files.forEach(function(file) {
		if(fs.statSync(dirPath + "/" + file).isDirectory()) {
			arrayOfFiles = getAllFiles(dirPath + "/" + file, depth, i + 1, arrayOfFiles);
		} else {
			arrayOfFiles.push(path.join(dirPath, "/", file));
		}
	});

	return arrayOfFiles;
}

function encrypt(str, strength, uri = false) {
	var codes = [];
	strength %= 256;

	for(var i = 0; i < str.length; i++) {
		var char = str.charCodeAt(i);
		codes[i] = i % 2 ? char ^ strength : char ^ (256 - strength);
	}

	var chars = codes.map(e => String.fromCharCode(e)).join("");
	var fixedRange = unescape(encodeURIComponent(chars));
	var hash = btoa(fixedRange);

	return uri ? encodeURIComponent(hash) : hash;
}

function decrypt(hash, strength) {
	var fixedRange = atob(decodeURIComponent(hash));
	var chars = decodeURIComponent(escape(fixedRange));
	var codes = [];
	strength %= 256;

	for(var i = 0; i < chars.length; i++) {
		var char = chars.charCodeAt(i);
		codes[i] = i % 2 ? char ^ strength : char ^ (256 - strength);
	}

	var str = codes.map(e => String.fromCharCode(e)).join("");

	return str;
}

module.exports = {
	Server,
	RequestEvent,
	CookieJar,
	CLI,
	KEY,
	atob,
	btoa,
	encrypt,
	decrypt,
	readFileAsync,
	writeFileAsync,
	getAllFiles,
	Send,
	editJSON,
	getContentType,
	getFileFormat
};

if(require.main === module) Server.begin();