const {EventListener} = require("./JustLib.js");

class CLI extends EventListener {
	constructor({stdin, stdout, stderr/*, fixPromises = true*/}, customKeyMap = {}) {
		super();

		/**
		 * @param {String} event Event name
		 * @param {Function} callback Event handler
		 * @type {
				((event: 'command', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'input', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'stdout', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'stderr', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'stderr', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'unknownCommand', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'keypress', listener: (event: EventListener.Event) => void) => EventListener.Listener) &
				((event: 'load', listener: (event: EventListener.Event) => void) => EventListener.Listener)
			}
		*/
		this.on;

		this.stdin = stdin;
		this.stdout = stdout;
		this.stderr = stderr;

		this.prompt = "> ";
		this.autocomplete = "";
		this.hint = "";
		this.buffer = "";
		this.current = "";
		this.cursor = 0;
		this.pointer = 0;
		this.history = [];
		this.isResumed = false;
		this.printCommand = true;

		this.KEY = {...KEY, ...customKeyMap};
	}

	begin() {
		//Setup stdin
		this.stdin?.setRawMode?.(true);
		this.stdin?.setEncoding?.("utf8");
		this.stdin.on("data", key => this._keyPressed(key, this.stdout));

		//Setup stdout
		this.stdout?.setEncoding?.("utf8");
		this.stdout.__write = this.stdout.write;
		this.stdout.write = (string, encoding, fd) => {
			this.stdout.__write.apply(this.stdout, [(this.isResumed ? "\r\x1b[K" : "") + string, encoding, fd]);
			this._updateCLI();
			this.dispatchEvent("stdout", {data: string, string: this._unescape(string)});
		};

		//Setup stderr
		this.stderr?.setEncoding?.("utf8");
		this.stderr.__write = this.stderr.write;
		this.stderr.write = (string, encoding, fd) => {
			this.stderr.__write.apply(this.stderr, [(this.isResumed ? "\r\x1b[K\r\x1b[K" : "") + string, encoding, fd]);
			this._updateCLI();
			this.dispatchEvent("stderr", {data: string, string: this._unescape(string)});
		};

		//Begin
		this.stdout.write(this.prompt);
		this.resume();

		this.dispatchEvent("load");
	}

	setPrompt(prompt) {
		this.prompt = prompt || "";
		this._updateCLI();
	}

	setHint(hint) {
		this.hint = hint || null;
		this._updateCLI();
	}

	setAutocomplete(text) {
		this.autocomplete = text || null;
		this._updateCLI();
	}

	setPrintCommand(state) {
		this.printCommand = !!state;
	}

	pause() {
		this.isResumed = false;
		this.stdin.pause();
	}

	resume() {
		this.isResumed = true;
		this.stdin.resume();
	}

	sendInput(input, cli = this, targetStream = this.stdout) {
		const args = input.trim().split(" ");
		const command = args.shift();

		//Output
		if(this.printCommand) this.dispatchEvent("stdout", {data: (cli.prompt + input + "\n"), string: cli._unescape(cli.prompt + input + "\n")});

		//Input
		targetStream.__write.apply(targetStream, ["\r\x1b[K" + (this.printCommand ? cli.prompt + input + "\r\n" : "") + cli.prompt]);
		this.dispatchEvent("command", {input, command, args}, event => {
			this.dispatchEvent("unknownCommand", event);
		});
		this.dispatchEvent("input", {input});
	}


	getInput(prompt = this.prompt) {
		return new Promise((resolve, reject) => {
			const temp = this.prompt;
			this.prompt = prompt;

			const listener = this.addEventListener("input", e => {
				this.prompt = temp;
				this.removeEventListener(listener);
				resolve(e.input);
			});
		});
	}

	_updateCLI() {
		const offset = this.prompt.length + this.cursor + 1;

		const START = `\x1b[1G`;
		const UP = `\x1bA`;
		const DOWN = `\x1bB`;
		const ERASE_LINE = `\x1b[K`;
		const OFFSET_CURSOR = `\x1b[${offset}G`;

		const autocomplete = this.autocomplete || "";
		const hint = this.hint ? `\n${ERASE_LINE}${this.hint}${UP}` : "";

		const output = `${START}${ERASE_LINE}${this.prompt}${this.buffer}${autocomplete}${START}${hint}${OFFSET_CURSOR}`;

		this.stdout.__write.apply(this.stdout, [output]);
	}

	_unescape(string) {
		return string.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	}

	_keyCompare(buffer1, buffer2) {
		if(!buffer1 || !buffer2) return false;
		if(buffer1.length != buffer2.length) return false;

		for(var i = 0; i < buffer1.length; i++) {
			if(buffer1[i] != buffer2[i]) return false;
		}
		return true;
	}

	_keyPressed(key, stream = this.stdout) {
		if(key.length > 1 && key.charCodeAt(0) != 27) {
			for(var char of key) {
				this._keyProcess(char, stream);
			}
		} else this._keyProcess(key, stream);
	}

	_keyProcess(key, stream = this.stdout) {
		const buffer = [...key].map(e => e.charCodeAt(0));

		if(this._keyCompare(buffer, this.KEY.ARROW_UP)) {
			if(this.pointer == this.history.length)
				this.current = this.buffer;
			if(this.pointer) {
				this.buffer = this.history[--this.pointer];
				this.cursor = this.buffer.length;

				this._updateCLI();
			}
		}
		else if(this._keyCompare(buffer, this.KEY.ARROW_DOWN)) {
			if(this.pointer < this.history.length) {
				this.buffer = this.history[++this.pointer] || this.current;
				this.cursor = this.buffer.length;

				this._updateCLI();
			}
		}
		else if(this._keyCompare(buffer, this.KEY.ARROW_LEFT)) {
			this.cursor--;
			if(this.cursor < 0)
				this.cursor = 0;
			else
				stream.__write.apply(stream, [key]);
		}
		else if(this._keyCompare(buffer, this.KEY.ARROW_RIGHT)) {
			this.cursor++;
			if(this.cursor > this.buffer.length)
				this.cursor = this.buffer.length;
			else
				stream.__write.apply(stream, [key]);
		}
		else if(this._keyCompare(buffer, this.KEY.CTRL_ARROW_LEFT)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index).reverse();
			const index = jumps.find(e => e < this.cursor && this.cursor - e != 1) || 0;

			this.cursor = index;
			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.CTRL_ARROW_RIGHT)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index);
			const index = jumps.find(e => e > this.cursor && e - this.cursor != 1) || this.buffer.length;

			this.cursor = index;
			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.BACKSPACE)) {
			this.cursor--; if(this.cursor < 0)
				return this.cursor = 0;
			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(this.cursor + 1);

			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.DELETE)) {
			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(this.cursor + 1);

			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.CTRL_BACKSPACE)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index).reverse();
			const index = jumps.find(e => e < this.cursor && this.cursor - e != 1) || 0;

			this.buffer = this.buffer.substring(0, index) + this.buffer.substring(this.cursor);
			this.cursor = index;

			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.CTRL_DELETE)) {
			const jumps = [...this.buffer.matchAll(/\b/g)].map(e => e.index);
			const index = jumps.find(e => e > this.cursor && e - this.cursor != 1) || this.buffer.length;

			this.buffer = this.buffer.substring(0, this.cursor) + this.buffer.substring(index);

			this._updateCLI();
		}
		else if(this._keyCompare(buffer, this.KEY.RETURN)) {
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
			this.buffer = this.buffer.substring(0, this.cursor) + key + this.buffer.substring(this.cursor);
			this.cursor++;

			this._updateCLI();
		}

		this.dispatchEvent("keypress");
	}
}

const KEY = {
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

exports.CLI = CLI;
exports.KEY = KEY;