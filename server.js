//@ts-check

const formidable = require("formidable");
const http = require("http");
const path = require("path");
const util = require("util");
const fs = require("fs");
const {EventListenerStatic, EventListener, fixDigits, iterate, getQueryParameters, objectDeepMerge} = require("./JustLib.js");
const {CLI, KEY} = require("./CLI");

const btoa = data => Buffer.from(data, "binary").toString("base64");
const atob = data => Buffer.from(data, "base64").toString("binary");

const PATH = {
	CONFIG: __dirname + "/config.json",
	TRUSTED_IPS: __dirname + "/trustedips.json",
	BLACKLIST: __dirname + "/blacklist.json",
	MODULES: __dirname + "/modules/",
	PUBLIC: __dirname + "/public/",
	LOGS: __dirname + "/logs/"
};

/**
 * @typedef {Object<string, any>} ObjectLiteral
 */

//TODO: Replace status numbers with `Server.STATUS` enum

class Server extends EventListenerStatic {
	/**
	 * @typedef {{username: string, password: string} | {token: string}} Credentials
	 */

	/**
	 * @typedef {Object} Module
	 * @prop {string} name Name of the module
	 * @prop {string | null} project Name of the project the module belongs to; `null` if module is not part of any project
	 * @prop {string} path Path to the module file
	 * @prop {boolean} loaded Flag indicating if the module has been loaded
	 * @prop {boolean} failed Flag indicating if the module failed to load
	 * @prop {any} exports The exports of the module
	 */

	/**
	 * Title of the server terminal window
	 * @type {string}
	 */
	static title = "";

	/**
	 * Cache of loaded modules.
	 * Property key is the relative path to the module file.
	 * @type {Object<string, Module>}
	 */
	static modules = {};

	/**
	 * Server standard input/output
	 * @static
	 * @type {{cli: CLI | null, settings: {logs: boolean, warnings: boolean, errors: boolean}}} obj1
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
	 * @typedef {Object} PerformanceInstance
	 * @prop {bigint} start 
	 * @prop {bigint} end
	 * @prop {number} total
	 * @prop {bigint} last
	 * @prop {number} delta
	 * @prop {string} label
	 * @prop {string} message
	 * @prop {boolean} isRunning
	 */

	static Performance = class Performance {
		/** @type {Object<string, PerformanceInstance>} */
		static instances = {
			__default__: {
				start: 0n,
				end: 0n,
				total: 0,
				last: 0n,
				delta: 0,
				label: "default",
				message: "New time point",
				isRunning: false
			}
		};

		/**
		 * Starts a new performance measurement instance.
		 * Can be called multiple times with the same label.
		 * At the end of the measurement, call `Server.Performance.finish(label)` to finalize the measurement.
		 * @static
		 * @param {string} [label="__default__"] Instance label to measure
		 * @param {string} [message="New time point"] Info for the following measurement
		 */
		static measure(label = "__default__", message = "New time point") {
			const now = process.hrtime.bigint();

			if(!this.instances[label]) this.instances[label] = {
				start: 0n,
				end: 0n,
				total: 0,
				last: 0n,
				delta: 0,
				label: label,
				message: message,
				isRunning: false
			};

			const instance = this.instances[label];

			if(instance.isRunning) {
				instance.delta = Number(now - instance.last);
				instance.total = Number(now - instance.start);

				const deltaMs = (instance.delta / 1000000).toFixed(3);
				const totalMs = (instance.total / 1000000).toFixed(3);
				const deltaDuration = Server.formatDuration(+deltaMs);

				Server.log(`§7[Performance] [§f${instance.label}§7] [${totalMs}ms] §f${instance.message}§7 ${deltaDuration}§7`);

				instance.message = message;
			} else {
				instance.isRunning = true;
				instance.start = process.hrtime.bigint();
			}

			instance.last = process.hrtime.bigint();
		}

		/**
		 * Finishes the performance measurement instance.
		 * @static
		 * @param {string} [label="__default__"] Instance label to finish
		 * @return {void} 
		 */
		static finish(label = "__default__") {
			const now = process.hrtime.bigint();

			if(!this.instances[label]) return Server.error(`Failed to finish performance measurement: Instance '${label}' does not exist`);
			if(!this.instances[label].isRunning) return Server.error(`Failed to finish performance measurement: Instance '${label}' is not running`);

			const instance = this.instances[label];

			instance.delta = Number(now - instance.last);
			instance.total = Number(now - instance.start);
			instance.end = now;
			instance.isRunning = false;

			const deltaMs = (instance.delta / 1000000).toFixed(3);
			const totalMs = (instance.total / 1000000).toFixed(3);
			const deltaDuration = Server.formatDuration(+deltaMs);
			const totalDuration = Server.formatDuration(+totalMs, {showSign: false});

			Server.log(`§7[Performance] [§f${instance.label}§7] [${totalMs}ms] §f${instance.message}§7 ${deltaDuration}§7 (Finished in ${totalDuration}§7)`);

			delete this.instances[label];
		}
	};

	/**
	 * HTTP server instance
	 * @type {http.Server}
	 */
	static http;

	/**
	 *
	 *
	 * @static
	 * @type {import("./ssh").SSHServer | null}
	 * @memberof Server
	 */
	static ssh = null;

	/**
	 * Controls logging of the unknown command error.
	 * In case you are using `input` event only on `Server.stdio.cli` (and not using `command` event),
	 * you may want to set this to `false`, so server won't show error every time you input something
	 * @type {boolean}
	 */
	static unknownCommandError = true;

	/**
	 * List of trusted IP addresses
	 * @type {string[]}
	 */
	static TRUSTED_IPS = [];

	/**
	 * List of blacklisted IP addresses
	 * @type {string[]}
	 */
	static BLACKLIST = [];

	/**
	 * @type {typeof PATH}
	 */
	static PATH = PATH;

	/**
	 * Flag indicating if the server is stopping
	 * @type {boolean}
	 */
	static isStopping = false;

	/** @type {string} */
	static __dirname = __dirname;

	/** @type {string} */
	static __filename = __filename;

	/** @type {string | "development"} */
	static environment = process.env.NODE_ENV || "development";

	/** @type {fs.WriteStream | null} */
	static loggerStream = null;

	/**
	 * @type {
		((event: string, listener: (event: RequestEvent) => void) => EventListener.Listener) &
		((event: "request", listener: (event: RequestEvent) => void) => EventListener.Listener) &
		((event: "load", listener: (event: EventListener.Event) => void) => EventListener.Listener) &
		((event: "unload", listener: (event: EventListener.Event & {forced: boolean}) => void) => EventListener.Listener) &
		((event: "404", listener: (event: RequestEvent) => void) => EventListener.Listener) &
		((event: "500", listener: (event: RequestEvent) => void) => EventListener.Listener)
	   }
	 */
	static on = (() => {
		const __on = this.on;

		//Generate regex expression for event handlers
		return (function(/**@type {string}*/event) {
			//Create a new event listener
			const _listener = __on.apply(this, arguments);

			//Create regex from wildcard characters
			if(["*", "?", ":"].some(e => event.includes(e))) {
				const _usedNames = {};

				_listener.regex = new RegExp(
					"^" //Start of the path
					+ event
						.replace(/(\.|\(|\)|\[|\]|\||\{|\}|\+|\^|\$|\/|\-|\\)/g, "\\$1") //Escape special characters
						.replace(/\?/g, "(.)") //Replace "?" with "any character"
						.replace(/\*/g, "(.*)") //Replace "*" with "any character(s)"
						.replace(/:(\w*)/g, (match, name) => { //Replace ":" with "named parameter"
							if(!name) throw new Error(`Failed to register event handler: Missing parameter name (${event})`);

							// Count same parameter names
							if(name in _usedNames) _usedNames[name]++;
							else _usedNames[name] = 0;

							return `(?<${name}${_usedNames[name] > 0 ? _usedNames[name] : ""}>[^/]+?)`;
						})
					+ "\/?" //Trailing slash
					+ "$" //End of the path
					, "i");
			} else {
				//Event does not contain any wildcards or is not a http request handler
				_listener.regex = null;
			}

			return _listener;
		}).bind(this);
	})();

	/**
	 * @static
	 * @memberof Server
	 */
	static async begin() {
		//Set up logger
		const filename = this.getFileNameFromDate(new Date());
		const filepath = path.join(PATH.LOGS, `${filename}.log`);
		if(!fs.existsSync(PATH.LOGS)) fs.mkdirSync(PATH.LOGS);
		this.loggerStream = fs.createWriteStream(filepath, {flags: "a"});

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

		if(!this.config["enable-logging"]) {
			this.loggerStream.end();
			this.log("§eLogging is disabled!");
		}

		//CLI
		if(this.config["enable-cli"]) {
			this.log("§7Enabling CLI...");
			this.stdio.cli = new CLI(
				process,
				// Remap backspace key on Linux
				process.platform === "linux" ? {
					...KEY,
					BACKSPACE: KEY.CTRL_BACKSPACE,
					CTRL_BACKSPACE: KEY.BACKSPACE,
				} : KEY
			);
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
					this.log(`Blacklisted IPs(${this.BLACKLIST.length}):\n${this.BLACKLIST.join("\n")}`);
				} else if(command == "eval") {
					try {
						e.preventDefault();
						this.log(util.formatWithOptions({colors: true}, "< %O", await eval(args.join(" "))));
					} catch(e) {
						this.log(`[EVAL ERROR]: ${e?.message || `Unknown error (${e?.message})`}`);
					}
				} else if(command == "exec") {
					const [filePath = "autoexec.cfg"] = args;

					fs.promises.readFile(path.join(__dirname, filePath)).then(file => {
						Server.log(`Executing ${filePath}...`);
						this.stdio.cli?.sendInput(file.toString());
					}).catch(err => {
						this.log(`§c[ERROR]: ${err.message}`);
					});
				} else if(command == "who") {
					e.preventDefault();

					if(!this.ssh) return this.error("SSH server is not enabled!");

					const connections = this.ssh.connections;

					if(connections.length == 0) return this.log("No connections");

					this.log(`Active connections(${connections.length}):`);

					const maxUsername = connections.reduce((max, connection) => Math.max(max, connection.username.length), 0);
					const maxDate = connections.reduce((max, connection) => Math.max(max, connection.date.toISOString().replace("T", " ").slice(0, 19).length), 0);
					const maxIP = connections.reduce((max, connection) => Math.max(max, connection.ip.length), 0);

					for(const connection of connections) {
						this.log(`${connection.username.padEnd(maxUsername)}  ${connection.ip.padEnd(maxIP)}  ${connection.date.toISOString().replace("T", " ").slice(0, 19).padEnd(maxDate)}`);
					}

				} else if(command == "") {

				} else return;

				e.preventDefault();
			});

			// Log input
			this.stdio.cli.on("input", e => {
				this.loggerStream?.write(`${this.stdio.cli?.prompt}${e.input}\n`);
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

			//SSH Server
			if(this.config["ssh"]["enabled"]) {
				//Try to load optional SSH module
				try {
					this.log("§7Loading SSH module...");
					var {SSHServer} = (this.__CommonJS_cache["ssh.js"] = require("./ssh"));

					//If module loaded, create new SSH server
					this.log("§7Enabling SSH server...");
					this.ssh = new SSHServer({
						localCLI: this.stdio.cli,
						port: this.config["ssh"]["port"]
					});
					await this.ssh.begin();

					this.on("unload", () => {
						this.ssh?.stop();
					});

					this.log("§7SSH server enabled");
				} catch(err) {
					this.error("Failed to load SSH module: " + err.message);
				}
			}
		} else this.log(`§7CLI disabled`);

		//Init
		if(!this.title) this.setTitle();

		//Create HTTP server
		if(this.config["enable-http-server"]) {
			//Create a new empty public folder for serving static files
			if(!fs.existsSync(PATH.PUBLIC)) {
				this.log(`§7Creating new empty §fpublic §7folder...`);
				fs.mkdirSync(PATH.PUBLIC);
			}

			//Create HTTP server instance and and add all listeners
			this.log("§7Creating HTTP server...");
			this.http = http.createServer();
			this.http.on("request", this._handleRequest.bind(this));
			this.http.on("error", err => {
				this.error("HTTP Server Error:", err.message);
			});
			this.http.on("close", e => {
				this.log(`§7HTTP server closed`);
			});
			this.http.on("listening", e => {
				this.log(`§7HTTP server is listening on port §f${this.config["http-port"]}`);
			});
			this.log(`§7HTTP server created`);
		} else {
			this.log(`§6HTTP server is disabled!`);
		}

		//Modules
		this._loadModules();

		//Load event
		this.log("§7Loading server...");
		await this.dispatchEvent("load", {async: true});
		this.log("§7Server loaded");

		//Make HTTP server listen for incoming requests
		if(this.config["enable-http-server"]) {
			await new Promise(resolve => {
				this.http.on("listening", resolve);
				this.http.on("error", resolve);
				this.http.listen(this.config["http-port"]);
			});
		}

		//Print startup duration
		this.log(`§7Initialization done (§ftook ${new Date().getTime() - startDate.getTime()}ms§7)`);
	}

	/**
	 * Stops the server and fires the "unload" event
	 * @static
	 * @param {number} [code=0] Exit code
	 * @param {boolean} [force=false] Toggles force flag in unload event
	 * @memberof Server
	 */
	static stop(code = 0, force = false) {
		this.log("§cStopping server...");

		this.isStopping = true;
		if(this.config["enable-http-server"] && this.http && this.http.listening) this.http.close();
		this._saveBlacklist();

		this.dispatchEvent("unload", {forced: force, async: true}).then(() => {
			this.log("§cServer stopped");
			if(this.loggerStream) this.loggerStream.end(() => process.exit(code));
			else process.exit(code);
		});
	}

	/**
	 * Internal method for handling incoming requests
	 * @static
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 * @param {string | undefined} [redirectTo]
	 * @param {RequestEvent} [prevEvent]
	 * @return {void} 
	 * @memberof Server
	 */
	static _handleRequest(req, res, redirectTo = undefined, prevEvent = undefined) {
		if(redirectTo && !prevEvent) throw new TypeError("Cannot redirect request if there is no RequestEvent provided");

		//Handle invalid requests
		if(!req.url) {
			res.writeHead(400);
			res.end("400 Bad Request");
			return this._connectionLog(400);
		}

		const _remoteAdd = req.socket.remoteAddress || "";
		const remoteIp = _remoteAdd.split(":")[3] || _remoteAdd;
		const proxyIp = req.headers["x-forwarded-for"];
		const protocol = req.headers["x-forwarded-proto"] || "http";
		const host = req.headers["host"];
		const ip = proxyIp || remoteIp;
		const origin = `${protocol}://${req.headers.host}`;
		const isTrusted = this.TRUSTED_IPS.some(e => ip.includes(e));
		const isBlacklisted = this.BLACKLIST.some(e => ip.includes(e));

		try {
			var url = new URL(req.url, origin);
		} catch(err) {
			res.writeHead(400);
			res.end("400 Bad Request");
			this.warn(`§cInvalid URL '${req.url}':`, err);
			return this._connectionLog(400);
		}

		//Request handling
		let destinationPath = decodeURIComponent(redirectTo || url.pathname);
		const resolvedPath = this.resolvePublicResource(destinationPath);

		/** @type {RequestEvent} */
		const EventObject = prevEvent || new RequestEvent({
			req,
			res,
			method: req.method,
			remoteIp: remoteIp,
			proxyIp: proxyIp,
			ip: ip,
			host: (host || ""),
			origin: origin,
			protocol,
			path: destinationPath,
			query: Object.fromEntries(url.searchParams.entries()),
			url: url,
			isTrusted: isTrusted,
			defaultPreventable: true,
			autoPrevent: true,
			headers: req.headers,
			isRedirected: false,
			redirectChain: [destinationPath],
			resolvedPath: resolvedPath,

			RemoteIP: remoteIp, /* Deprecated */
			ProxyIP: proxyIp, /* Deprecated */
			IP: ip, /* Deprecated */
			HOST: (host || ""), /* Deprecated */
			Path: destinationPath, /* Deprecated */
			IS_TRUSTED: isTrusted, /* Deprecated */
			resolvedFile: resolvedPath, /* Deprecated */
		});

		if(!redirectTo) {
			if(isTrusted) this.log(`§2Incoming request from ${host ? `§2(${host})` : ""}§2${remoteIp}${proxyIp ? `§3(${proxyIp})` : ""}§2: §2${req.method} §2${req.url}`);
			else this.log(`§2Incoming request from ${host ? `§2(${host})` : ""}§a${remoteIp}${proxyIp ? `§b(${proxyIp})` : ""}§2: §a${req.method} §a${req.url}`);

			if(isBlacklisted) {
				this.warn(`Received request from blacklisted IP (${ip})`);
				return EventObject.send("403 Forbidden", 403);
			}
		}

		//Updated properties from previous request event
		if(redirectTo) {
			EventObject.redirectChain.push(destinationPath);
			EventObject.isRedirected = true;
			EventObject.path = destinationPath;
			EventObject.Path = destinationPath; /* Deprecated */
			EventObject.resolvedPath = resolvedPath;
			EventObject.resolvedFile = resolvedPath;

			//Reset `Event`'s internal properties
			EventObject.isStopped = false;
			EventObject.hasListener = false;
			EventObject.defaultPrevented = false;
		}

		//Fix destination path ending with "/"
		if(destinationPath.length > 1 && destinationPath.endsWith("/")) destinationPath = destinationPath.slice(0, -1);
		//if(destinationPath.length > 1 && destinationPath.endsWith("/")) EventObject.redirectURL(destinationPath.slice(0, -1), this.STATUS.REDIRECT.MOVED_PERMANENTLY);

		//Dispatch events
		(async () => {
			//Dispatch "request" event
			await this.dispatchEvent("request", EventObject);
			if(EventObject.defaultPrevented) return;

			//Dispatch path event
			await this.dispatchEvent(destinationPath, EventObject);
			if(EventObject.defaultPrevented) return;

			//Dynamic destination path search
			const searchDispatched = [];
			const listenerPromises = [];

			for(const listener of this.listeners) {
				const type = listener.type;

				//Event was prevented
				if(EventObject.defaultPrevented) break;

				//Event was already dispatched
				if(searchDispatched.includes(type)) continue;

				//Listener uses dynamic representation of destination path
				if(listener.regex) {
					const match = destinationPath.match(listener.regex);

					//Destination path does not match required pattern
					if(!match) continue;

					//Add found matches to EventObject
					// @ts-ignore
					EventObject.matches = match.slice(1);
					EventObject.matches.matches = EventObject.matches;
					if(match.groups) {
						Object.assign(EventObject.matches, match.groups);
					}

					//Dispatch matched event
					searchDispatched.push(type);
					listenerPromises.push(this.dispatchEvent(type, EventObject));
				}
			}

			//Wait for all listeners to finish
			await Promise.all(listenerPromises);
		})().then(() => {
			//All listeners were processed

			//If no listeners responded (prevented default action), try to serve static file
			if(!EventObject.defaultPrevented) {
				if(res.writableEnded) return this.warn(`Failed to write response after end. (Default action has not been prevented)`);

				//The request path might be vulnerable
				if(!EventObject.resolvedPath) return EventObject.send("404 Not Found", 404);

				//Serve static file. This call will internally respond with 404 if file is not found.
				EventObject.streamFile(EventObject.resolvedPath);
			}
		}).catch(err => {
			//Catch all errors and process them
			this._handleInternalError(EventObject, err);
		});
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

	/**
	 *
	 * @static
	 * @param {RequestEvent} event
	 * @param {Error} error
	 * @memberof Server
	 */
	static _handleInternalError(event, error) {
		const clone = event.clone();
		clone.error = error;

		this.dispatchEvent("500", clone, () => {
			Server.error("Failed to handle the incoming request:", error);
			event.send("500 Internal Server Error", 500);
		});
	}

	/**
	 * Resolves the absolute path of a file inside the specified base directory.
	 * @static
	 * @param {string} baseDirectory Base directory to act as root
	 * @param {string} filePath File path to resolve from base directory
	 * @return {string | null} Resolved resource absolute path. Returns `null` if path cannot be resolved (potentially vulnerable).
	 * @memberof Server
	 */
	static resolveResource(baseDirectory, filePath) {
		//Normalize the input parameters
		const base = path.normalize(baseDirectory);
		const resource = path.normalize(filePath);

		//Poision null bytes prevention
		if(resource.indexOf("\0") !== -1) return null;

		//Resolve file path
		const resolved = path.resolve(path.join(base, resource));

		//Directory traversal prevention
		if(!resolved.startsWith(path.normalize(base))) return null;

		return resolved;
	}

	/**
	 * Resolves the absolute path of a file inside the public folder.
	 * @static
	 * @param {string} filePath Path to teh file located in public folder
	 * @return {string | null} Resolved absolute path to the file or `null` if path cannot be resolved (potentially vulnerable).
	 * @memberof Server
	 */
	static resolvePublicResource(filePath) {
		return this.resolveResource(PATH.PUBLIC, filePath);
	}

	/**
	 * Parses a range header from the request object and returns the range object.
	 * @static
	 * @param {http.IncomingMessage} req
	 * @param {number} totalLength
	 * @return {{start: number, end: number} | null} 
	 * @memberof Server
	 */
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

	/**
	 * Logs a connection status to the console
	 * @static
	 * @param {number} status
	 * @memberof Server
	 */
	static _connectionLog(status) {
		this.log(`§8Connection closed (${status})`);
	}

	/**
	 * Loads the configuration file
	 * @private
	 * @static
	 * @memberof Server
	 */
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

		//Add missing/new properties from default configuration
		const merged = objectDeepMerge(DEFAULT_CONFIG, config, false);

		//Update config
		if(JSON.stringify(config) !== JSON.stringify(merged)) {
			fs.writeFileSync(PATH.CONFIG, JSON.stringify(merged, null, "\t"));
			this.log(`§7Updated §f${name} §7with latest/missing properties`);
		}

		//Apply config
		this.config = merged;

		this.log("§7Configuration loaded");
	}

	/**
	 * Loads the server modules
	 * @private
	 * @static
	 * @memberof Server
	 */
	static _loadModules() {
		this.log("§7Loading modules...");
		const dirname = path.basename(path.dirname(PATH.MODULES + " "));

		// Create default module
		if(!fs.existsSync(PATH.MODULES)) {
			this.log(`§7Creating new empty §f${dirname} §7folder...`);
			fs.mkdirSync(PATH.MODULES);

			fs.writeFileSync(PATH.MODULES + "main.js", DEFAULT_MAIN);
		}

		// Collect all module files
		const files = getAllFiles(PATH.MODULES, 1);
		const start = Date.now();

		for(const file of files) {
			// Precompute names
			const basename = path.basename(path.dirname(file));
			const filename = path.basename(file);

			// Determine module and project name
			const project = basename == dirname ? null : basename;
			const moduleName = (project ? `${project}/` : "") + filename;

			//Skip files prefixed with '-'
			if(filename.startsWith("-")) continue;

			//Skip not '*.js' files
			if(!file.endsWith(".js") || fs.lstatSync(file).isDirectory()) continue;

			// Create a module object
			const _module = {
				name: moduleName,
				project: project,
				path: file,
				loaded: false,
				failed: false,
				exports: undefined
			};
			this.modules[moduleName] = _module;

			//Execute file
			try {
				// Load the module
				const start = Date.now();
				_module.exports = require(file);
				const duration = Date.now() - start;

				// Mark module as loaded
				_module.loaded = true;

				// Log the success message
				const formattedDuration = this.formatDuration(duration);

				this.log(`§7Loaded §f${project ? `${project}§7:§f` : ""}${filename} §7(${formattedDuration}§7)`);
			} catch(err) {
				// Mark module as failed
				_module.failed = true;

				// Log the error message
				this.error(`Failed to load '${filename}':`, err);
			}
		}

		// Log total stats
		this.log(`§7Loaded §f${Object.values(this.modules).filter(e => e.loaded).length}§7/§f${Object.values(this.modules).length} §7modules (§f${Date.now() - start}ms§7)`);
	}

	/**
	 * Loads the list of trusted IPs
	 * @private
	 * @static
	 * @memberof Server
	 */
	static _loadTrustedIPs() {
		this.log("§7Loading trusted IPs...");
		const name = path.basename(PATH.TRUSTED_IPS);

		//Create default
		if(!fs.existsSync(PATH.TRUSTED_IPS)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.TRUSTED_IPS, JSON.stringify(["localhost", "127.0.0.1", "::1"]));
		}

		//Apply Trusted IPs
		this.TRUSTED_IPS = JSON.parse(fs.readFileSync(PATH.TRUSTED_IPS).toString());

		this.log(`§7Loaded §f${this.TRUSTED_IPS.length} §7trusted IPs`);
	}

	/**
	 * Loads the list of blacklisted IPs
	 * @private
	 * @static
	 * @memberof Server
	 */
	static _loadBlacklist() {
		this.log("§7Loading blacklist...");
		const name = path.basename(PATH.BLACKLIST);

		//Create default
		if(!fs.existsSync(PATH.BLACKLIST)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.BLACKLIST, JSON.stringify([]));
		}

		//Apply Blacklist
		this.BLACKLIST = JSON.parse(fs.readFileSync(PATH.BLACKLIST).toString());

		this.log(`§7Loaded §f${this.BLACKLIST.length} §7blacklisted IPs`);
	}

	/**
	 * Saves the list of blacklisted IPs
	 * @private
	 * @static
	 * @memberof Server
	 */
	static _saveBlacklist() {
		this.log("§7Saving blacklist...");
		const name = path.basename(PATH.BLACKLIST);

		//Create default
		if(!fs.existsSync(PATH.BLACKLIST)) {
			this.log(`§7Creating new blank §f${name} §7file...`);
			fs.writeFileSync(PATH.BLACKLIST, JSON.stringify([]));
		}

		//Save blacklist
		fs.writeFileSync(PATH.BLACKLIST, JSON.stringify(this.BLACKLIST));

		this.log(`§7Saved §f${this.BLACKLIST.length} §7blacklisted IPs`);
	}

	/**
	 * @typedef {Object} DurationFormatterOptions
	 * @prop {number[]} [limits] Numerical limits of the durations, in ascending order (where the color changes) (length must be `colors.length - 1`)
	 * @prop {string[]} [colors] Format color codes present between the limits, in ascending order (length must be `limits.length + 1`)
	 * @prop {boolean} [showSign] Flag indicating whether to show the sign of the duration
	 */

	/**
	 * @static
	 * @param {number} duration Duration to format
	 * @param {DurationFormatterOptions} [options={}] Formatter options
	 * @return {string} Formatted string
	 * @memberof Server
	 */
	static formatDuration(duration, options = {}) {
		const {
			limits = [0, 250, 500],
			colors = ["§1", "§2", "§6", "§4"],
			showSign = true
		} = options || {};

		// Check for valid options
		if(limits.length != colors.length - 1) throw new Error(`Cannot format duration: length of 'limits' must be ${colors.length - 1}, but is ${limits.length}`);

		// Choose the color for the duration based on the options
		const color = colors[limits.findIndex(e => duration < e)] || colors[colors.length - 1];
		const sign = !showSign || Math.sign(duration) < 0 ? "" : "+";

		// Format the final string
		return `${color}${sign}${isNaN(duration) ? NaN : duration}ms`;
	}

	/**
	 * Format a string with color codes.
	 * @static
	 * @param {string} msg Message to format
	 * @return {string} Formatted message
	 * @memberof Server
	 */
	static formatMessage(msg) {
		const codes = ["30", "34", "32", "36", "31", "35", "33", "37", "90", "94", "92", "96", "91", "95", "93", "97"];

		return (msg + "§r§7")
			.replace(/(?<!§)§([0-9a-fr])/gi, (m, c) =>
				({
					"r": "\x1b[0m"
				})[c] || `\x1b[${codes[parseInt(c, 16)]}m`
			)
			.replace(/§§/g, "§");
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
			if(typeof arg === "string") return options.colors ?
				this.formatMessage(arg) :
				arg.replace(/§[0-9a-f]/g, "");

			params.push(arg);
			return "%O";
		}).join(" ");

		return util.formatWithOptions(options, format, ...params);
	}

	/**
	 * Formats input date into human readable string in format "[hh:mm:ss]"
	 * @static
	 * @param {Date | number} [time=Date.now()]
	 * @return {string} 
	 * @memberof Server
	 */
	static formatTime(time = Date.now()) {
		time = new Date(time);
		return `[${fixDigits(time.getHours())}:${fixDigits(time.getMinutes())}:${fixDigits(time.getSeconds())}]`;
	}

	/**
	 * @static
	 * @param {Date} date
	 * @return {string} 
	 * @memberof Instagram
	 */
	static getFileNameFromDate(date) {
		const offset = -date.getTimezoneOffset();
		const sign = offset < 0 ? "-" : "+";
		const d = new Date(date.getTime() + offset * 60 * 1000).toISOString();

		return d.replace(/:/g, "-").replace(/\.\d+/, "") + sign + fixDigits(offset / 60);
	}

	/**
	 * Sets the title of console window.
	 * @static
	 * @param {string} [title=`Node.js Server - ${__filename}`]
	 * @memberof Server
	 */
	static setTitle(title = `Node.js Server - ${__filename}`) {
		this.title = title;
		(process.stdout["__write"] || process.stdout.write).apply(process.stdout, [`${String.fromCharCode(27)}]0;${title}${String.fromCharCode(7)}`]);
	}

	/**
	 * Logs message to stdout.
	 * @static
	 * @param {...any} args
	 * @memberof Server
	 */
	static log(...args) {
		if(!Server.stdio.settings.logs) return;

		const formattedArgs = Server.formatArguments(args, {colors: true, depth: 4});
		const message = `${Server.formatTime()} ${formattedArgs}`;
		console.log(message);
		Server.loggerStream?.write(`${Server._unescape(message)}\n`);
	}

	/**
	 * Logs warning message to stderr.
	 * @static
	 * @param {...any} args
	 * @memberof Server
	 */
	static warn(...args) {
		if(!Server.stdio.settings.warnings) return;

		const formattedArgs = Server.formatArguments(args, {colors: false, depth: 4});
		const message = `\x1b[33m${Server.formatTime()} [WARN]: ${formattedArgs}\x1b[0m`;
		console.warn(message);
		Server.loggerStream?.write(`${Server._unescape(message)}\n`);
	}

	/**
	 * Logs error message to stderr.
	 * @static
	 * @param {...any} args
	 * @memberof Server
	 */
	static error(...args) {
		if(!Server.stdio.settings.errors) return;

		const formattedArgs = Server.formatArguments(args, {colors: false, depth: 4});
		const message = `\x1b[31m${Server.formatTime()} [ERROR]: ${formattedArgs}\x1b[0m`;
		console.error(message);
		Server.loggerStream?.write(`${Server._unescape(message)}\n`);
	}

	/**
	 * Removes all color codes from string.
	 * @static
	 * @param {string} string
	 * @return {string} 
	 * @memberof Server
	 */
	static _unescape(string) {
		return string.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	}

	//Cache to store loaded optional CommonJS modules
	static __CommonJS_cache = {};
}

/**
 *
 * @class RequestEvent
 * @extends {EventListener.Event}
 */
class RequestEvent extends EventListener.Event {
	/**
	 * @typedef {Object<string, string>} RequestQuery
	 */

	/**
	 * @typedef {(event: RequestEvent, next: Function) => void} MiddlewareCallback
	 */

	/**
	 * @typedef {(query: RequestQuery) => void} RequestCallbackGET
	 */

	/**
	 * @typedef {(query: RequestQuery) => void} RequestCallbackOPTIONS
	 */

	/**
	 * @typedef {Object} POSTMultipartField
	 * @property {string | formidable.File} value Last received value for this field (including files)
	 * @property {(string | formidable.File)[]} array Array of all values for this field (including files)
	 * @property {formidable.File[]} files Array of all files for this field
	 * @property {string[]} fields Array of all values for this field
	 */

	/**
	 * POST request multipart body. Contains all fields and files received.
	 * Property key is the field name.
	 * @typedef {Object<string, POSTMultipartField>} POSTMultipartBody
	 */

	/**
	 * @typedef {string | number | ObjectLiteral | any[] | boolean | null | undefined} POSTJSONBody 
	 */

	/**
	 * @typedef {string} POSTTextBody
	 */

	/**
	 * @typedef {ObjectLiteral} POSTFormBody
	 */

	/**
	 * @typedef {Buffer} POSTRawBody
	 */

	/**
	 * @typedef {POSTMultipartBody | POSTJSONBody | POSTTextBody | POSTFormBody | POSTRawBody} POSTBody
	 */

	/**
	 * @typedef {"json" | "json-object" | "json-array" | "form" | "multipart" | "text" | "raw"} POSTBodyType 
	 */

	/**
	 * @typedef {
			((callback: RequestCallbackGET) => boolean) &
			((middleware: MiddlewareCallback, callback: RequestCallbackGET) => boolean) &
			((middlewares: MiddlewareCallback[], callback: RequestCallbackGET) => boolean)
		} RequestHandlerGET
	 */

	/**
	 * @typedef {
			((callback: (bodyParsed: POSTBody, bodyBuffer: Buffer) => void) => boolean) &
			((callback: (bodyParsed: POSTTextBody, bodyBuffer: Buffer) => void, type: "text") => boolean) &
			((callback: (bodyParsed: POSTJSONBody, bodyBuffer: Buffer) => void, type: "json") => boolean) &
			((callback: (bodyParsed: ObjectLiteral, bodyBuffer: Buffer) => void, type: "json-object") => boolean) &
			((callback: (bodyParsed: Array<any>, bodyBuffer: Buffer) => void, type: "json-array") => boolean) &
			((callback: (bodyParsed: POSTFormBody, bodyBuffer: Buffer) => void, type: "form") => boolean) &
			((callback: (bodyParsed: POSTMultipartBody) => void, type: "multipart") => boolean) &
			((callback: (bodyParsed: POSTRawBody, bodyBuffer: Buffer) => void, type: "raw") => boolean) &

			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTBody, bodyBuffer: Buffer) => void) => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTTextBody, bodyBuffer: Buffer) => void, type: "text") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTJSONBody, bodyBuffer: Buffer) => void, type: "json") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: ObjectLiteral, bodyBuffer: Buffer) => void, type: "json-object") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: Array<any>, bodyBuffer: Buffer) => void, type: "json-array") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTFormBody, bodyBuffer: Buffer) => void, type: "form") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTMultipartBody) => void, type: "multipart") => boolean) &
			((middleware: MiddlewareCallback, callback: (bodyParsed: POSTRawBody, bodyBuffer: Buffer) => void, type: "raw") => boolean) &

			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTBody, bodyBuffer: Buffer) => void) => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTTextBody, bodyBuffer: Buffer) => void, type: "text") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTJSONBody, bodyBuffer: Buffer) => void, type: "json") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: ObjectLiteral, bodyBuffer: Buffer) => void, type: "json-object") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: Array<any>, bodyBuffer: Buffer) => void, type: "json-array") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTFormBody, bodyBuffer: Buffer) => void, type: "form") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTMultipartBody) => void, type: "multipart") => boolean) &
			((middleware: MiddlewareCallback[], callback: (bodyParsed: POSTRawBody, bodyBuffer: Buffer) => void, type: "raw") => boolean)
		} RequestHandlerPOST
	 */

	/**
	 * @typedef {(callback: RequestCallbackOPTIONS) => boolean} RequestHandlerOPTIONS
	 */


	/**
	 * @type {
			((event: string, listener: (event: RequestEvent) => void) => EventListener.Listener) &
			((event: 'beforesend', listener: (event: EventListener.Event & {responseData: any, responseStatus: number, responseHeaders: http.OutgoingHttpHeaders}) => void) => EventListener.Listener)
		}
	 */
	on;

	/**
	 * Request object
	 * @type {http.IncomingMessage}
	 */
	req;

	/**
	 * Response object
	 * @type {http.ServerResponse}
	 */
	res;

	/**
	 * Request method
	 * @type {string}
	 */
	method;

	/**
	 * Remote IP address
	 * @type {string}
	 */
	remoteIp;

	/**
	 * Remote IP address
	 * @deprecated Use `remoteIp` instead
	 * @type {string}
	 */
	RemoteIP;

	/**
	 * Forwarded IP address
	 * @type {string}
	 */
	proxyIp;

	/**
	 * Forwarded IP address
	 * @deprecated Use `proxyIp` instead
	 * @type {string}
	 */
	ProxyIP;

	/**
	 * IP address of the client
	 * @type {string}
	 */
	ip;

	/**
	 * IP address of the client
	 * @deprecated Use `ip` instead
	 * @type {string}
	 */
	IP;

	/**
	 * Request host
	 * @type {string}
	 */
	host;

	/**
	 * Request host
	 * @deprecated Use 'host' instead
	 * @type {string}
	 */
	HOST;

	/**
	 * Request protocol
	 * @type {"http" | "https"}
	 */
	protocol;

	/**
	 * Request origin
	 * @type {string}
	 * @example "https://www.example.com"
	 */
	origin;

	/**
	 * Request destination path
	 * @type {string}
	 */
	path;

	/**
	 * Request destination path
	 * @deprecated Use 'path' instead
	 * @type {string}
	 */
	Path;

	/**
	 * Request query string parameters object
	 * @type {RequestQuery}
	 */
	query;

	/**
	 * Parsed request URL
	 * @type {URL}
	 */
	url;

	/**
	 * Tells if the request comes from trusted origin
	 * @type {boolean}
	 */
	isTrusted;

	/**
	 * Tells if the request comes from trusted origin
	 * @deprecated Use 'isTrusted' instead
	 * @type {boolean}
	 */
	IS_TRUSTED;

	/**
	 * Enables auto prevent when calling methods 'get', 'post', 'send', 'sendFile', 'streamFile'...
	 * @type {boolean}
	 */
	autoPrevent;

	/**
	 * Array of matches, if wildcard handler was used.
	 * Contains properties named by defined parameters in the event handler with their corresponding matched values.
	 * @type {string[] & {[param: string]: string} & {matches: string[]}}
	 */
	matches;

	/**
	 * HTTP headers sent by the client
	 * @type {http.IncomingHttpHeaders}
	 */
	headers;

	/**
	 * Determines if the request was redirected
	 * @type {boolean}
	 */
	isRedirected;

	/**
	 * Array of redirected paths
	 * @type {string[]}
	 */
	redirectChain;

	/**
	 * `true` if the request body was successfully received and parsed, otherwise `false`
	 * @type {boolean}
	 */
	isBodyReceived = false;

	/**
	 * Received body raw buffer
	 * @type {Buffer | null}
	 */
	bodyRaw = null;

	/**
	 * Parsed body data
	 * `undefined` if the body was not received yet or could not be parsed
	 * @type {POSTBody | undefined}
	 */
	body = undefined;

	/**
	 * Represents custom data object. Could be used in the middlewares to transfer data into event handlers.
	 * @type {ObjectLiteral}
	 */
	data = {};

	/**
	 * Error thrown by any of the request handlers
	 * @type {(ObjectLiteral & Error) | null}
	 */
	error = null;

	/**
	 * Resolved path to requested file or directory in local file system. Can contain `null` value, in case the resource cannot be resolved.
	 * @type {string | null}
	 */
	resolvedPath;

	/**
	 * Resolved path to requested file in local file system
	 * @deprecated Use 'resolvedResource' instead
	 * @type {string | null}
	 */
	resolvedFile;

	/**
	 * Formidable options
	 * @type {formidable.Options}
	 */
	formidableOptions = {
		maxFileSize: 200 * 1024 * 1024
	};

	/**
	 * Received POST body type determined by the content-type header
	 * @type {POSTBodyType | null}
	 */
	receivedPostType = null;

	/**
	 * Expected POST body type determined by the request handler
	 * @type {POSTBodyType | null}
	 */
	expectedPostType = null;

	/**
	 * Resolved POST body type determined by the request handler
	 * @type {POSTBodyType}
	 */
	resolvedPostType = "raw";

	/**
	 * Handles GET requests
	 * @returns {boolean} True if request was successfully handled, otherwise false
	 * @type {RequestHandlerGET}
	*/
	get = this.__get;

	/**
	 * Handles POST requests
	 * @returns {boolean} True if request was successfully handled, otherwise false
	 * @type {RequestHandlerPOST}
	*/
	post = this.__post;

	/**
	 * Handles OPTIONS requests
	 * @returns {boolean} True if request was successfully handled, otherwise false
	 * @type {RequestHandlerOPTIONS}
	*/
	options = this.__options;


	/**
	 * Creates an instance of RequestEvent.
	 * @param {*} data
	 * @memberof RequestEvent
	 */
	constructor(data) {
		super(data);

		//To make RequestEvent extend both EventListener.Event and EventListener
		const listener = new EventListener();
		Object.assign(this, listener);
		// @ts-ignore
		Object.defineProperties(this.__proto__, Object.getOwnPropertyDescriptors(listener.__proto__));

		// Copy the data here to prevent property shadowing
		for(const key in data) {
			this[key] = data[key];
		}

		//Properties to modify event distribution
		this.async = true;
		this.parallel = true;
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @private
	 */
	__get(middlewares, callback) {
		//Middlewares
		if(!callback && typeof middlewares === "function") { // f(callback)
			callback = middlewares;
			middlewares = [];
		}
		else if(callback && typeof middlewares === "function") middlewares = [middlewares]; // f(middleware, callback)
		else if(!callback) throw new TypeError("'callback' parameter is not type of function");
		else if(!(middlewares instanceof Array)) throw new TypeError("'middlewares' parameter is not type of function[]");

		const executor = (middlewares, i = 0) => {
			return async () => {
				try {
					if(i == middlewares.length) await callback(this.query);
					else await middlewares[i](this, executor(middlewares, i + 1));
				} catch(err) {
					Server._handleInternalError(this, err);
				}
			};
		};

		//Request handling
		if(this.req.method == "GET") {
			if(this.autoPrevent) this.defaultPrevented = true;

			executor(middlewares)();

			return true;
		} else return false;
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @private
	 */
	__post(middlewares, callback, type) {
		//Middlewares
		if(typeof middlewares === "function") {
			if(typeof callback === "function") { // f(middleware, callback[, type])
				middlewares = [middlewares];
			} else { // f(callback[, type])
				if(typeof callback === "string") type = callback; // f(callback, type)
				callback = middlewares;
				middlewares = [];
			}
		}

		if(!middlewares || (middlewares.length && typeof middlewares[0] !== "function")) throw new TypeError("'middlewares' parameter must be either type of function[] or function");
		if(typeof callback !== "function") throw new TypeError("'callback' parameter must be type of function");

		const executor = (middlewares, i = 0) => {
			return async () => {
				try {
					if(i == middlewares.length) await callback(this.body, this.bodyRaw);
					else await middlewares[i](this, executor(middlewares, i + 1));
				} catch(err) {
					Server._handleInternalError(this, err);
				}
			};
		};

		//Type checking
		const contentType = this.headers["content-type"] || "";

		if(contentType.indexOf("application/json") != -1) this.receivedPostType = "json";
		else if(contentType.indexOf("application/x-www-form-urlencoded") != -1) this.receivedPostType = "form";
		else if(contentType.indexOf("multipart/form-data") != -1) this.receivedPostType = "multipart";
		else if(contentType.indexOf("text") != -1) this.receivedPostType = "text";
		else this.receivedPostType = "raw";

		this.expectedPostType = type || null;
		this.resolvedPostType = this.expectedPostType || this.receivedPostType;

		middlewares.push(Server.POST_BODY_HANDLER);

		//Request Handling
		if(this.req.method == "POST") {
			executor(middlewares)();

			return true;
		} else return false;
	}

	__options(callback) {
		if(typeof callback !== "function") throw new TypeError("'callback' parameter is not type of function");

		if(this.req.method == "OPTIONS") {
			if(this.autoPrevent) this.defaultPrevented = true;

			(async () => {
				await callback(this.query);
			})().catch(err => {
				Server._handleInternalError(this, err);
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

		this.preventDefault();
		this.res.writeHead(status, {"Location": destination});
		this.res.end();
		Server._connectionLog(status);
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

		const shouldUseToken = "token" in credentials;
		const shouldUseCreds = "username" in credentials && "password" in credentials;

		//Handle callback type
		if(hasCallback && typeof callback !== "function") throw new TypeError(`Callback '${callback}' is not type of function or null`);

		//No auth header
		if(!auth && (!basic || !bearer)) {
			if(forceLogin) this.send("", 401, "text/html", {
				"www-authenticate": shouldUseToken ? `Bearer realm="${realm}"` : `Basic realm="${realm}"`
			});
			return false;
		}

		//Bearer auth
		if(shouldUseToken) {
			//Check access
			if(bearer !== credentials.token) {
				if(forceLogin) this.send("401 Unauthorized: Invalid token", 401);
				Server.log(`§eInvalid token attempt '${bearer}'!`);
				return false;
			}

			Server.log(`§eToken '${bearer}' just used!`);
			if(hasCallback) callback(credentials);
			return true;
		}

		//Basic auth
		if(shouldUseCreds) {
			//Decode credentials
			try {
				var [username, password] = atob(basic).split(":");
			} catch(err) {
				Server.error("Failed to parse authorization header:", basic, err);

				this.send("400 Bad Request: Authorization header malformed", 400);
				return false;
			}

			//Check access
			if(username !== credentials.username || password !== credentials.password) {
				if(forceLogin) this.send("401 Unauthorized: Invalid credentials", 401);
				Server.log(`§eUnsuccessful login attempt '${username}:${password}'!`);
				return false;
			}

			Server.log(`§eUser '${username}' just logged in!`);
			if(hasCallback) callback(credentials);
			return true;
		}

		//Unsupported auth
		this.send("500 Internal Server Error: Cannot process provided authentication type", 500);
		throw new TypeError("Invalid credentials / unsupported authentication type" + JSON.stringify({credentials, auth}));
	}

	/**
	 * Send response to the client
	 * @param {string | ObjectLiteral | Buffer | ReadableStream} data Data to be sent as response
	 * @param {number} [status=200] Response status code
	 * @param {string | "text/plain" | "text/html" | "application/json" | "image/png" | "audio/mpeg" | "video/mp4"} [contentType="text/plain"] Content type of the response
	 * @param {http.OutgoingHttpHeaders} [headers={}] Response headers
	 */
	send(data, status = 200, contentType = "text/plain", headers = {}) {
		this.preventDefault();

		// Response already sent
		if(this.res.writableEnded) {
			this._logWriteAfterEndWarning(new Error());
			return;
		}

		//Send data
		const isObject = typeof data === "object";
		const isBuffer = data instanceof Buffer;
		// @ts-ignore
		const isStream = !!data.pipe;

		const computedContentType = ((isBuffer || isStream) ? contentType : (isObject ? "application/json" : contentType)) || "text/plain";

		const responseHeaders = {
			"Content-Type": `${computedContentType}; charset=utf-8`,
			...headers
		};

		// @ts-ignore
		this.dispatchEvent("beforesend", {
			responseData: data,
			responseStatus: status,
			responseHeaders: responseHeaders
		}, event => {
			this.res.writeHead(event.responseStatus, event.responseHeaders);

			if(isStream) {
				event.responseData.pipe(this.res);
			} else {
				this.res.write(isBuffer ? event.responseData : (isObject ? JSON.stringify(event.responseData) : event.responseData + ""));
				this.res.end();
			}

			Server._connectionLog(event.responseStatus);
		});
	}

	/**
	 * @typedef {Object} SendOptions
	 * @prop {string | ObjectLiteral | Buffer | ReadableStream} data 
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
		if(this.res.writableEnded) return this._logWriteAfterEndWarning(new Error()), false;

		const stat = await fs.promises.stat(filePath).catch(() => { });
		if(!stat || stat.isDirectory()) {
			Server._handleNotFound(this);
			return false;
		}

		headers["Content-Length"] = stat.size;

		//Send file
		this.send(fs.createReadStream(filePath), status, getContentType(filePath), headers);
		return true;
	}

	/**
	 * Stream file using partial content response
	 * @param {string} filePath
	 * @param {number | http.OutgoingHttpHeaders} [status=200]
	 * @param {http.OutgoingHttpHeaders} [headers={}]
	 * @returns {Promise<boolean>}
	 * @memberof RequestEvent
	 */
	async streamFile(filePath, status = 200, headers = {}) {
		this.preventDefault();
		if(this.res.writableEnded) return this._logWriteAfterEndWarning(new Error()), false;

		const _status = (typeof status === "number" ? status : 200) || 200;
		const _headers = (typeof status === "object" ? status : headers) || {};

		const contentType = getContentType(filePath);
		const stat = await fs.promises.stat(filePath).catch(() => { });
		if(!stat || stat.isDirectory()) {
			Server._handleNotFound(this);
			return false;
		}

		const range = Server.readRangeHeader(this.req, stat.size);

		if(!range) {
			_headers["Content-Length"] = stat.size;
			this.send(fs.createReadStream(filePath), _status, contentType, _headers);
			return true;
		}

		//Request cannot be fulfilled due to incorrect range
		if(range.start >= stat.size || range.end >= stat.size) {
			//Send correct range
			_headers["Content-Range"] = `bytes */${stat.size}`;
			this.send("416 Range Not Satisfiable", 416, contentType, _headers);
		} else {
			//Set up headers
			_headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
			_headers["Content-Length"] = range.start == range.end ? 0 : (range.end - range.start + 1);
			_headers["Accept-Ranges"] = "bytes";
			//headers["Cache-Control"] = "no-cache";

			//Send part of file
			this.send(fs.createReadStream(filePath, range), 206, contentType, _headers);
		}
		return true;
	}

	/**
	 * Stream resource from public directory
	 * @param {string} filePath
	 * @param {number} [status=200]
	 * @param {http.OutgoingHttpHeaders} [headers={}]
	 * @returns {Promise<boolean>}
	 * @memberof RequestEvent
	 */
	async streamPublicFile(filePath, status = 200, headers = {}) {
		const resolvedPath = Server.resolvePublicResource(filePath);

		if(!resolvedPath) {
			Server._handleNotFound(this);
			return false;
		}

		return this.streamFile(resolvedPath, status, headers);
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
	 * Set formidable options, which will be used for handling multipart/form-data request
	 * @param {formidable.Options} options
	 * @memberof RequestEvent
	 */
	setFormidableOptions(options) {
		this.formidableOptions = options;
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

	/**
	 *
	 * @private
	 * @param {Error} error Error object need to be passed from the faulty place to keep the stack trace clean
	 * @memberof RequestEvent
	 */
	_logWriteAfterEndWarning(error) {
		error.name = "";
		error.message = "Failed to write response after end. (Maybe 'send()', 'sendFile()', 'streamFile()' are being called multiple times or you forgot to call 'preventDefault()'?)";
		Server.warn(error);
	}
}


/**
 * @typedef {Object} CookieProperties
 * @prop {string} [Domain] Host to which the cookie will be sent.
 * @prop {string} [Expires] The maximum lifetime of the cookie as an HTTP-date timestamp.
 * @prop {string} [Max-Age] Number of seconds until the cookie expires. A zero or negative number will expire the cookie immediately.
 * @prop {string} [Path] A path that must exist in the requested URL, or the browser won't send the `Cookie` header.
 * @prop {"Strict" | "Lax" | "None"} [SameSite] Controls whether a cookie is sent with cross-origin requests, providing some protection against cross-site request forgery attacks (CSRF).
 * @prop {boolean} [HttpOnly] The cookie cannot be read by client-side JavaScript. This restriction eliminates the threat of cookie theft via cross-site scripting (XSS).
 * @prop {boolean} [Partitioned] Indicates that the cookie should be stored using partitioned storage.
 * @prop {boolean} [Secure] A secure cookie is only sent to the server when a request is made with the https: scheme.
 */
class CookieJar {
	/**
	 * @typedef {
		  {
			headers: ({
				raw(): {
					[k: string]: string[]
				}
			} | {
				getSetCookie(): string[]
			}) & ObjectLiteral
		} & ObjectLiteral} FetchLikeResponse 
	 */

	/** @type {
		((cookie: string, value: string, options?: ObjectLiteral) => this) &
		((cookie: string[]) => this) &
		((cookie: CookieJar.Cookie) => this) &
		((cookie: CookieJar.Cookie[]) => this) &
		((cookie: http.IncomingMessage) => this) &
		((cookie: FetchLikeResponse) => this) &
		((cookie: http.ServerResponse) => this)
	} */
	setCookie;

	/** @type {CookieJar.Cookie[]} */
	cookies;

	/**
	 * Creates an instance of CookieJar.
	 * @param {any[]} args
	 * @memberof CookieJar
	 */
	constructor(...args) {
		this.cookies = [];

		this.setCookie = (...args) => {
			//Set by name=value
			{
				const [name, value, options = {}] = /**@type {[string, string, CookieProperties]}*/(args);

				if(typeof value === "string") {
					if(!name) return Server.warn("Cannot set cookie: Cookie name is empty"), this;

					const cookie = new CookieJar.Cookie(name.trim(), value.trim(), options);

					this._addCookiesToJar(cookie);
					return this;
				}
			}

			//Set by array of cookie strings
			{
				const [cookieStrings] = /**@type {[string[]]}*/(args);

				if(Array.isArray(cookieStrings) && typeof cookieStrings[0] === "string") {
					const cookies = CookieJar.Cookie.parse(cookieStrings);

					this._addCookiesToJar(...cookies);
					return this;
				}
			}

			//Set by Cookie object
			{
				const [cookie] = /**@type {[CookieJar.Cookie]}*/(args);

				if(cookie instanceof CookieJar.Cookie) {
					this._addCookiesToJar(cookie);
					return this;
				}
			}

			//Set by Cookie array
			{
				const [cookies] = /**@type {[CookieJar.Cookie[]]}*/(args);

				if(Array.isArray(cookies) && cookies[0] instanceof CookieJar.Cookie) {
					this._addCookiesToJar(...cookies);
					return this;
				}
			}

			//Set by Request object
			{
				const [request] = /**@type {[http.IncomingMessage]}*/(args);

				if(request instanceof http.IncomingMessage) {
					const cookieString = request.headers.cookie;
					if(!cookieString) return this;

					const cookies = CookieJar.Cookie.parse(cookieString.split(";"));

					this._addCookiesToJar(...cookies);
					return this;
				}
			}

			//Set by Response object (http)
			{
				const [response] = /**@type {[http.ServerResponse]}*/(args);

				if(response instanceof http.ServerResponse) {
					const cookieString = response.getHeader("set-cookie");
					if(!cookieString) return this;

					const cookieArray = Array.isArray(cookieString) ? cookieString : [`${cookieString}`];
					const cookies = CookieJar.Cookie.parse(cookieArray);

					this._addCookiesToJar(...cookies);
					return this;
				}
			}

			//Set by Response object (fetch)
			{
				const [response] = /**@type {[FetchLikeResponse]}*/(args);

				/** @type {string[] | undefined} */
				let cookieArray = undefined;

				// Try the get the cookies from the raw headers somehow
				if(typeof response?.headers?.getSetCookie === "function") {
					const cookieArray = response.headers.getSetCookie();
					if(!cookieArray) return this;
				} else if(typeof response?.headers?.raw === "function") {
					const cookieArray = response.headers.raw()["set-cookie"];
					if(!cookieArray) return this;
				}

				if(cookieArray) {
					const cookies = CookieJar.Cookie.parse(cookieArray);

					this._addCookiesToJar(...cookies);
					return this;
				}
			}

			//Set by JSON object
			{
				const [jsonObject] = /**@type {[CookieJar]}*/(args);

				if(typeof jsonObject === "object" && jsonObject !== null && "cookies" in jsonObject) {
					for(const cookieObject of jsonObject.cookies) {
						const cookie = new CookieJar.Cookie(cookieObject.name, cookieObject.value, cookieObject.props);
						this._addCookiesToJar(cookie);
					}
					return this;
				}
			}

			throw new TypeError(`Cannot set cookie: [${args[0]}, ${args[1]}, ${args[2]}]`);
		};

		// Parse input arguments
		if(arguments.length) this.setCookie.apply(this, arguments);
	}

	/**
	 * Returns cookie object found by name
	 * @param {string} name Cookie name
	 * @param {boolean} [expired=true] Include expired cookies
	 * @returns {CookieJar.Cookie | null} Cookie object if found, otherwise undefined
	 * @memberof CookieJar
	 */
	getCookie(name, expired = true) {
		const cookies = this.getCookies(expired);
		return cookies.find(cookie => cookie.name == name) || null;
	}

	/**
	 * Removes cookie from the Jar
	 * @param {string | CookieJar.Cookie} cookie
	 * @returns {CookieJar.Cookie | null} Deleted cookie
	 * @memberof CookieJar
	 */
	deleteCookie(cookie) {
		// Obtain the index of the cookie
		let index = -1;
		if(typeof cookie === "string") index = this.cookies.findIndex(e => e.name === cookie);
		else if(cookie instanceof CookieJar.Cookie) index = this.cookies.indexOf(cookie);

		// Validate the index
		if(index === -1) return null;

		// Remove the cookie
		return this.cookies.splice(index, 1)[0] || null;
	}

	/**
	 * Sends header with cookies
	 * @param {http.ServerResponse} response Server response object
	 * @param {boolean} [full=true] Include cookie properties
	 * @param {boolean} [expired=full] Include expired cookies
	 * @returns {this}
	 * @memberof CookieJar
	 */
	sendCookies(response, full = true, expired = full) {
		const cookies = this.getCookies(expired).map(e => e.toString(full));
		response.setHeader("Set-Cookie", cookies);
		return this;
	}

	/**
	 * Converts Cookie object to cookie string
	 * @param {boolean} [full=true] Include cookie properties
	 * @param {boolean} [expired=full] Include expired cookies
	 * @returns {string} Cookie String
	 * @memberof CookieJar
	 */
	toString(full = true, expired = full) {
		const cookies = this.getCookies(expired).map(e => e.toString(full));
		return cookies.join("");
	}

	/**
	 * Checks if the Jar is empty
	 * @param {boolean} [expired=true] Include expired cookies
	 * @returns {boolean} true if Jar is empty, otherwise false
	 * @memberof CookieJar
	 */
	isEmpty(expired = true) {
		const cookies = this.getCookies(expired);
		return cookies.length === 0;
	}

	/**
	 * Checks if the Jar contains cookie with certain name
	 * @param {string} name Cookie name
	 * @param {boolean} [expired=true] Include expired cookies
	 * @returns {boolean} true if Jar contains cookie with certain name, otherwise false
	 * @memberof CookieJar
	 */
	includes(name, expired = true) {
		return !!this.getCookie(name, expired);
	}

	/**
	 * Removes expired cookies from the Jar
	 * @memberof CookieJar
	 */
	removeExpiredCookies() {
		for(const cookie of this.cookies) {
			if(cookie.isExpired()) this.deleteCookie(cookie);
		}
	}

	/**
	 * Return unexpired cookies form the jar
	 * @returns {CookieJar.Cookie[]}
	 * @memberof CookieJar
	 */
	getUnexpiredCookies() {
		return this.cookies.filter(cookie => !cookie.isExpired());
	}

	/**
	 * Return cookies in the jar
	 * @param {boolean} [expired=true] Include expired cookies
	 * @returns {CookieJar.Cookie[]}
	 * @memberof CookieJar
	 */
	getCookies(expired = true) {
		return expired ? this.cookies : this.getUnexpiredCookies();
	}

	/**
	 * Adds cookies to the Jar
	 * @param {CookieJar.Cookie[]} cookies
	 * @memberof CookieJar
	 */
	_addCookiesToJar(...cookies) {
		for(const cookie of cookies) {
			if(!(cookie instanceof CookieJar.Cookie)) continue;
			this.deleteCookie(cookie.name);
			this.cookies.push(cookie);
		}
	}
}

/**
 * @typedef {Object} Cookie
 */
CookieJar.Cookie = class Cookie {
	/**
	 * Creates an instance of Cookie.
	 * @param {string} name
	 * @param {string | number | boolean} value
	 * @param {CookieProperties} [properties={}]
	 */
	constructor(name, value, properties = {}) {
		this.name = name.trim();
		this.value = `${value}`.trim();

		/** @type {CookieProperties} */
		this.props = properties || {};
	}

	/**
	 * Convert cookie to cookie string
	 * @param {boolean} [full=true] Include cookie properties and flags
	 * @returns {string} Cookie String
	 */
	toString(full = true) {
		const props = [`${this.name}=${this.value}`];

		for(const [i, key, value] of iterate(this.props)) {
			if(!value) continue;
			props.push(typeof value === "string" ? `${key}=${value}` : key);
		}

		return `${full ? props.join("; ") : props[0]}; `;
	}

	/**
	 * Checks if the cookie is expired
	 * @return {boolean} 
	 */
	isExpired() {
		const expires = this.props["Expires"];
		if(!expires) return false;

		return new Date(expires).getTime() < Date.now();
	}

	// eslint-disable-next-line valid-jsdoc
	/**
	 * @static
	 * @param {string} key
	 * @return {(keyof CookieProperties) | false} 
	 */
	static formatKeyword(key) {
		return /**@type {(keyof CookieProperties)[]}*/(["Expires", "Max-Age", "Domain", "Path", "Secure", "HttpOnly", "Partitioned", "SameSite"])
			.find(keyword => keyword.toLowerCase() == key.toLowerCase()) || false;
	}

	/**
	 * @static
	 * @param {string[]} cookieStringArray
	 * @return {CookieJar.Cookie[]} 
	 */
	static parse(cookieStringArray) {
		return cookieStringArray.map(cookieString => {
			const cookie = new CookieJar.Cookie("", "");
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
					cookie.props[this.formatKeyword(flag) || flag] = true;
				} else {
					//throw new TypeError("Failed to parse cookie: '" + property + "'");
					Server.warn(`Failed to parse cookie: '${property}'`);
				}
			}

			return cookie;
		});
	}
};

const DEFAULT_CONFIG = {
	"http-port": 80,
	"enable-http-server": true,
	"enable-logging": true,
	"enable-cli": true,
	"debug": true,
	"login": {
		"username": "admin",
		"password": "admin"
	},
	"ssh": {
		"enabled": false,
		"port": 22
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

//Handle 500 Internal Server Error
Server.on("500", e => {
	e.send("Something went wrong :/");
});

//Handle dynamic request
//There are two special characters available:
//'*' - extends to /(.*)/ regex (matches 0 or more characters)
//'?' - extends to /(.)/ regex (matches 1 character)
//':' - extends to /([^/]+?)/ regex (matches 1 or more characters, until '/')
//Example: let's say we want format like this: '/user/<user>/<page>' => '/user/john123/profile'
Server.on("/user/:user/:page", e => {
	//e.matches contains ordered matches from requested url
	//get 'user' and 'page' from matched url
	const {user, page} = e.matches;

	if(page == "profile") {
		//Send user their profile page
		e.send("Welcome back " + user);
	} else if(page == "settings") {
		//do more stuff...
	}

	//If no response was sent, the 404 status will be sent
});

//Example: '/file/<username>/<path_to_file>' => '/file/john123/path/to/my/file.txt'
Server.on("/user/:user/*", e => {
	const [username, path] = e.matches;
	//or const {username, matches: [, path]} = e.matches;

	//Query the database to obtain user id
	const user_id = "213465879";

	//Serve file from fs
	e.streamFile("/user_content/" + user_id + "/" + path);
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

const CONTENT_TYPES = /**@type {const}*/({
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
});
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

// eslint-disable-next-line valid-jsdoc
/** @type {MiddlewareCallback} */
Server.POST_BODY_HANDLER = function(event, next) {
	// Ignore if method is not POST
	if(event.method !== "POST") return;

	if(event.autoPrevent) event.defaultPrevented = true;

	//Skip body handling if it's already handled
	if(event.isBodyReceived) {
		next();
		return;
	}

	const type = event.resolvedPostType;

	if(type === "multipart") {
		const contentLength = parseInt(event.req.headers["content-length"] || "");
		if(isNaN(contentLength)) return event.send("411 Length Required", Server.STATUS.CLIENT.LENGTH_REQUIRED);

		if(event.formidableOptions.maxFileSize && contentLength > event.formidableOptions.maxFileSize) {
			event.send("413 Payload Too Large", Server.STATUS.CLIENT.PAYLOAD_TOO_LARGE);
			return;
		}

		const form = new formidable.IncomingForm(event.formidableOptions);
		const body = {};

		//Handle multipart/form-data request body
		form.parse(event.req, err => {
			if(err) throw err;

			//Create single value properties
			for(const key in body) {
				if(!body.hasOwnProperty(key)) continue;

				const field = body[key];
				field.value = field.array[field.array.length - 1];
			}

			//Set internal properties
			event.body = body;
			event.bodyRaw = null;
			event.isBodyReceived = true;

			next();
		});

		form.on("error", err => {
			Server.error("Failed to handle multipart request:", err);
			event.send("500 Internal Server Error", 500);
		});

		//Handle multiple files
		form.on("file", (field, file) => {
			if(!body[field]) body[field] = {
				array: [],
				files: [],
				values: [],
				value: null
			};
			body[field].array.push(file);
			body[field].files.push(file);
		});

		//Handle multiple fields
		form.on("field", (field, value) => {
			if(!body[value]) body[field] = {
				array: [],
				files: [],
				values: [],
				value: null
			};
			body[field].array.push(value);
			body[field].values.push(value);
		});
	} else {
		const chunks = [];

		event.req.on("data", chunk => {
			chunks.push(chunk);
		});

		event.req.on("end", () => {
			const buffer = Buffer.concat(chunks);
			let body = undefined;

			if(type.startsWith("json")) {
				try {
					body = JSON.parse(buffer.toString());

					// Parse as an Object
					if(
						type === "json-object" &&
						(typeof body !== "object" || body === null || Array.isArray(body))
					) body = {};

					// Parse as an Array
					else if(
						type === "json-array" &&
						!Array.isArray(body)
					) body = [];
				} catch(err) {
					body = undefined;
				}
			} else if(type === "form") {
				body = Object.fromEntries(new URLSearchParams(buffer.toString()));
			} else if(type === "text") {
				body = buffer.toString();
			} else if(type === "raw") {
				body = buffer;
			} else {
				throw new TypeError(`'${type}' is invalid content type`);
			}

			event.body = body;
			event.bodyRaw = buffer;
			event.isBodyReceived = true;

			next();
		});
	}
};


/* Helper Functions */
/**
 * Asynchronously reads a file
 * @deprecated Use `fs.promises.readFile` instead
 * @param {any[]} args
 * @return {any} 
 */
function readFileAsync(...args) {
	return fs.promises.readFile.apply(fs.promises, arguments);
}

/**
 * Asynchronously writes a data to a file
 * @deprecated Use `fs.promises.writeFile` instead
 * @param {any[]} args
 * @return {any} 
 */
function writeFileAsync(...args) {
	return fs.promises.writeFile.apply(fs.promises, arguments);
}

/**
 * @deprecated Use `RequestEvent.send(...)` instead
 * @param {*} res
 * @param {*} data
 * @param {number} [status=200]
 * @param {string} [type="text/plain"]
 * @param {*} [headers={}]
 */
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

// eslint-disable-next-line valid-jsdoc
/**
 * @deprecated
 * @param {string} path
 * @param {((json: ObjectLiteral) => ObjectLiteral) | null} [callback=null]
 * @return {Promise<ObjectLiteral>} 
 */
async function editJSON(path, callback = null) {
	const json = JSON.parse(await readFileAsync(path));

	if(typeof callback === "function") {
		const newJson = callback(json);
		await writeFileAsync(path, JSON.stringify(newJson));
		return newJson;
	}

	return json;
}


// eslint-disable-next-line valid-jsdoc
/**
 * Resolves content type from filename
 * @example getContentType("index.html") // "text/html"
 * @example getContentType("file.idk") // "text/plain"
 * @example getContentType("file.idk", "text/x-unexpected") // "text/x-unexpected"
 * @param {string} filename
 * @param {(typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES] | string} [mismatch="text/plain"]
 * @return {(typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES] | string} 
 */
function getContentType(filename, mismatch = "text/plain") {
	const index = filename.lastIndexOf(".");
	return index === -1 ? mismatch : CONTENT_TYPES[filename.slice(index + 1)] || mismatch;
}

// eslint-disable-next-line valid-jsdoc
/**
 * Resolves file format from content type
 * @example getFileFormat("text/html") // "html"
 * @example getFileFormat("text/x-unexpected") // ""
 * @example getFileFormat("text/x-unexpected", "idk") // "idk"
 * @param {(typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES] | string} contentType
 * @param {(keyof typeof CONTENT_TYPES) | "" | string} [mismatch=""]
 * @return {(keyof typeof CONTENT_TYPES) | "" | string} 
 */
function getFileFormat(contentType, mismatch = "") {
	return /**@type {(keyof typeof CONTENT_TYPES) | undefined}*/(Object.keys(CONTENT_TYPES).find(key => CONTENT_TYPES[key] == contentType)) || mismatch;
}

/**
 * Recursively resolves all files in directory
 * @param {string} dirPath Starting directory
 * @param {number} [depth=Infinity] Max depth of recursion
 * @return {string[]} 
 */
function getAllFiles(dirPath, depth = Infinity) {
	if(!fs.existsSync(dirPath)) return [];
	if(!fs.statSync(dirPath).isDirectory()) return [dirPath];

	/** @type {{path: string, depth: number}[]} */
	const queue = [{path: dirPath, depth: 0}];

	/** @type {string[]} */
	const arrayOfFiles = [];

	while(queue.length) {
		const dir = queue.shift();
		if(!dir || dir.depth > depth) continue;

		const files = fs.readdirSync(dir.path);

		for(const file of files) {
			const pathname = path.join(dir.path, "/", file);

			if(fs.statSync(pathname).isDirectory()) {
				queue.push({
					path: pathname,
					depth: dir.depth + 1
				});
			} else {
				arrayOfFiles.push(pathname);
			}
		}
	}

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