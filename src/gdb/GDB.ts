import * as path from 'path';
import * as net from 'net';
import {spawn} from 'child_process';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as Adapter from '../DebugAdapter';
import * as MI from './MIParser';
import * as processes from '../processes';


import {
	DebugSession,
	DebuggerException,
	LaunchRequestArguments,
	adjustMemory,
	memoryReference,
	SCOPE,
} from '../DebugSession';

/*
type _DummyPromise = Promise<void> & {resolve: ()=> void};

function DummyPromise() : _DummyPromise {
	let _resolve;
	const p = new Promise<void>(resolve => _resolve = resolve);
	(p as any).resolve = _resolve;
	return p as _DummyPromise;
}
*/

class DeferredPromise {
	private promise = Promise.resolve();
	private resolver?: () => void;

	constructor(ready: boolean) {
		if (!ready)
			this.reset();
	}
	fire() {
		if (this.resolver) {
			this.resolver();
			this.resolver = undefined;
		}
	}
	reset() {
		this.promise = new Promise(resolve => this.resolver = resolve);
	}
	async wait() {
		await this.promise;
	}
	then<T = void>(onfulfilled?: () => T | PromiseLike<T>): Promise<T> {
		return this.promise.then(onfulfilled);
	}
}

// bit manipulation
function subset(set1: bigint, set2: bigint) {
	return (set1 & set2) === set1;
}

function bitlist(set: bigint) {
	const s = set.toString(2);
	let offset = s.length;
	const array = s.split('1').slice(0, -1).map(i => {
		offset -= i.length + 1;
		return offset;
	});

	return array.reverse();
}

// command helpers
function quoted(str: string): string {
	return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function breakpointConditions(condition?: string, hitCondition?: string) {
	return `${condition ? `-c ${quoted(condition)}` : ''} ${hitCondition ? `-i ${hitCondition}` : ''}`;
}
function granularity(granularity?: string) {
	return granularity === 'instruction' ? '-instruction' : '';
}

function isCompositeValue(value: string): boolean {
	return !!/(^0x)|{|<|\[|struct|class/.exec(value);
}

export async function async_replace(value: string, re: RegExp, process: (match: RegExpExecArray)=>Promise<string>): Promise<string> {
	let m;
	let i = 0;
	const combine = async (m: RegExpExecArray) => value.substring(i, m!.index) + await process(m!);

	const promises: Promise<string>[] = [];
	while ((m = re.exec(value))) {
		promises.push(combine(m));
		i = re.lastIndex;
	}
	return (await Promise.all(promises)).join('') + value.substring(i);
}

//-----------------------------------------------------------------------------
//	Registers
//-----------------------------------------------------------------------------

interface Register {
	name:		string,
	rel?:		number,
	offset?:	number,
	size?:		number,
	type?:		string,
	groups?:	string[]
}

interface RegisterGroup {
	includes:	bigint;
	children:	Record<string, RegisterGroup>;
	offset?:	number;
}

class Registers {
	private registers: Register[] = [];
	private registerGroups: RegisterGroup[] = [];
	private ready: Promise<void>;

	constructor(gdb: GDB) {
		this.ready = this.init(gdb);
	}

	private async init(gdb: GDB) {
//		const record		= await gdb.sendCommand('-data-list-register-names');
//		this.registers	= record.results['register-names'].map((name: string) => ({name}));

		const capture	= await gdb.capture_while(async () => {
			await gdb.sendCommand('-interpreter-exec console "maintenance print register-groups"'); }
		);
		const re = /^\s*(\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\w+,]+)/;
		capture.map(line => re.exec(line)).filter(match => match).forEach(match => {
			this.registers[parseInt(match![2])] = {
				name:	match![1],
				rel:	+match![3],
				offset:	+match![4],
				size:	+match![5],
				type:	match![6],
				groups:	match![7].split(',')
			};
		});

		// Create mapping of group -> registers
		const groups: Record<string, RegisterGroup> = {};
		const roots: string[] = [];

		this.registers.forEach((reg, i) => {
			const mask = 1n << BigInt(i);
			reg.groups?.forEach(group => {
				if (!groups[group])
					groups[group] = {includes: 0n, children: {}};
				groups[group].includes |= mask;
			});
		});

		// Build hierarchy by finding subsets and roots
		for (const g1 in groups) {
			let hasParent = false;
			for (const g2 in groups) {
				if (g1 !== g2) {
					if (groups[g1].includes === groups[g2].includes) {
						delete groups[g2];
					} else if (subset(groups[g1].includes, groups[g2].includes)) {
						groups[g2].children[g1] = groups[g1];
						hasParent = true;
					}
				}
			}
			if (!hasParent)
				roots.push(g1);
		}

		if (roots.length > 1) {
			this.registerGroups.push({
				includes: 0n,
				children: Object.fromEntries(roots.map(g => [g, groups[g]])),
				offset: 0,
			});
		} else {
			groups[roots[0]].offset = 0;
			this.registerGroups.push(groups[roots[0]]);
		}

		// remove children's registers and assign offsets
		for (const i in groups) {
			const g = groups[i];
			if (g.offset === undefined)
				g.offset = this.registerGroups.push(g) - 1;

			for (const c of Object.values(g.children))
				g.includes &= ~c.includes;
		}
	}

	async fetchGroup(gdb: GDB, id: number): Promise<DebugProtocol.Variable[]> {
		// Fetch registers
		await this.ready;
		const group		= this.registerGroups[id];
		const children	= Object.keys(group.children).map(i => ({
			name:				i,
			value:				'',
			variablesReference: SCOPE.REGISTERS + group.children[i].offset!,
		}));

		if (group.includes === 0n)
			return children;

		const record	= await gdb.sendCommand(`-data-list-register-values r ${bitlist(group.includes).map(i => i.toString()).join(' ')}`);
		return [
			...children,
			...record['register-values'].map((reg: MI.Register) => ({
				name:				this.registers[+reg.number].name,
				value:				reg.value,
				variablesReference:	0,
				memoryReference:	memoryReference(reg.value)
			}))
		];
	}
}

//-----------------------------------------------------------------------------
//	Globals
//-----------------------------------------------------------------------------

interface Global {
	readonly name: string;
	readonly type: string;
}

class Globals {
	private globals:	Global[] = [];
	private statics:	Record<string, {index: number, symbols: Global[]}> = {};
	private ready:		Promise<void>;

	constructor(gdb: GDB) {
		this.ready = this.init(gdb);
	}
	private async init(gdb: GDB) {
		const record	= await gdb.sendCommand(`-symbol-info-variables`);
		const symbols	= record.symbols as MI.Symbols;

		Object.values(this.statics).forEach((file, i) => {
			file.index = i;
			file.symbols.sort((a, b) => a.name < b.name ? -1 : 1);
		});

		this.globals	= symbols.debug.map(file => file.symbols
			.filter(sym => !sym.description.startsWith('static '))
			.map(sym => ({
				name:	sym.name,
				type:	sym.type,
			}))
		).flat().sort((a, b) => a.name < b.name ? -1 : 1);

		this.statics	= Object.fromEntries(symbols.debug.map(file => ({
			filename: file.fullname,
			index:		0,
			symbols:	file.symbols
				.filter(sym => sym.description.startsWith('static ')).map(sym => ({
					name: sym.name,
					type: sym.type
				}))
			})
		).filter(statics => statics.symbols.length)
		.map(statics => [statics.filename, statics]));
	}

	private static async fetch(gdb: GDB, globals: Global[]) {
		return (await Promise.all(globals.map(async (g): Promise<DebugProtocol.Variable | undefined> => {
			try {
				const value = await gdb.evaluateExpression(g.name);
				let		refId	= 0;
				if (isCompositeValue(value)) {
					const v	=	await gdb.createVariable(g.name);
					refId = v.referenceID;
				}
				return {
					name:					g.name,
					value,
					type:					g.type,
					variablesReference:	refId,
					memoryReference:		memoryReference(value)
				};
			} catch (e) {
				//
			}
		}))).filter(v => v) as DebugProtocol.Variable[];
	}

	async fetchGlobals(gdb: GDB, start: number, count?: number): Promise<DebugProtocol.Variable[]> {
		await this.ready;
		const globals = count ? this.globals.slice(start, start + count) : this.globals.slice(start);
		return Globals.fetch(gdb, globals);
	}
	async fetchStatics(gdb: GDB, id: number): Promise<DebugProtocol.Variable[]> {
		return Globals.fetch(gdb, this.statics[id].symbols);
	}
	staticsIndex(fullname: string) {
		return this.statics[fullname]?.index ?? -1;
	}
}

//-----------------------------------------------------------------------------
//	GDB
//-----------------------------------------------------------------------------

interface Variable {
	name:			string;
	debuggerName:	string;	// The unique "name" assigned by the underlying MI debugger need not be identical to the actual source location name
	value:			string;
	type:			string;
	referenceID:	number;	// 0 if no children
	children?:		Record<string, Variable>;
}

export class GDB extends DebugSession {
	private		parser = new MI.MIParser();

	// Libraries for which debugger has loaded debug symbols for
	private		loadedLibraries: Record<string, boolean> = {};

	// Used to sync MI inputs and outputs. Value increases by 1 with each command issued
	private		token = 0;
	// Callbacks to execute when a command identified by "token" is resolved by the debugger
	private		handlers: {[token: number]: (record: MI.ResultRecord) => void} = [];

	private breakpoints:			Record<string, number[]> = {};
	private logBreakpoints:			Record<number, string> = {};
	private functionBreakpoints:	Record<string, number> = {};
	private exceptionBreakpoints:	Record<string, number> = {};
	private dataBreakpoints:		Record<string, number> = {};
	private instsBreakpoints:		Record<string, number> = {};

	private globals?:			Globals;
	private registers?:			Registers;

	// Mapping of symbolic variable names to GDB variable references
	private variables:			Variable[] = [];
	private frames:				{thread: number, frame: number, statics: number}[] = [];
	private sources:			(() => Promise<string>)[] = [];
	private remoteSources:		Record<string, number> = {};

	private threadId			= -1;
	private inferiorStarted		= false;
	private inferiorRunning		= false;
	private python				= false;
	private pythonCommand		= '';
	private ignorePause			= false;
	private stopped				= new DeferredPromise(true);
	private ready				= new DeferredPromise(false);
	private startupPromises: Promise<void>[] = [];

	// when set, capture debugger output lines
	private capture?:	string[];

	private addStartup() : () => void {
		if (this.inferiorStarted)
			return () => {};
		let _resolve : ()=>void;
		const p = new Promise<void>(resolve => _resolve = resolve);
		this.startupPromises.push(p);
		return _resolve!;
	}

	private frameCommand(frameId?: number) {
		if (frameId === undefined)
			return '';

		const frame = this.frames[frameId];
		if (!frame)
			throw new Error(`No frame ${frameId}`);
		return `--frame ${frame.frame} --thread ${frame.thread}`;
	}

	private sendStopped(reason: string, threadId: number, allThreadsStopped?: boolean, text?: string): void {
		this.inferiorRunning	= false;
		this.threadId			= threadId;
		this.sendEvent(new Adapter.StoppedEvent({reason, threadId, allThreadsStopped, text}));
		this.stopped.fire();
		this.frames = [];
	}

	private continue() {
		this.ignorePause = false;
		return this.sendCommand('-exec-continue');
	}

	// process one line from debugger
	protected recvServer(line: string): void {
		try {
			const record = this.parser.parse1(line);
			if (!record)
				return;

			switch (record.$type) {
				case MI.RecordType.CONSOLE:
					if (this.capture)
						this.capture.push(record.cstring);
					else
						this.sendEvent(new Adapter.OutputEvent({category: 'console', output: record.cstring}));
					break;

				case MI.RecordType.TARGET:
					this.sendEvent(new Adapter.OutputEvent({category: 'stdout', output: record.cstring}));
					break;

				case MI.RecordType.LOG:
					this.sendEvent(new Adapter.OutputEvent({category: 'log', output: record.cstring}));
					if (record.cstring.includes('internal-error'))
						this.sendEvent(new Adapter.TerminatedEvent({restart: !this.inferiorStarted}));
					break;

				case MI.RecordType.RESULT:
					if (isNaN(record.$token)) {
						this.sendEvent(new Adapter.OutputEvent({category: 'console', output: line}));

					} else {
						const handler = this.handlers[record.$token];
						if (handler) {
							handler(record);
							delete this.handlers[record.$token];
						} else {
							// There could be instances where we should fire DAP events even if the request did not originally contain
							// a handler. For example, up/down should correctly move the active stack frame in VSCode
						}
					}
					break;

				case MI.RecordType.EXEC:
					switch (record.$class) {
						case 'stopped': {
							const reason		= record.reason;
							const allStopped	= record['stopped-threads'] === 'all';
							const threadId		= +record['thread-id'];

							if (!reason) {
								if (this.inferiorStarted)
									this.sendStopped('breakpoint', threadId, allStopped);
								this.inferiorRunning	= false;
								return;
							}

							switch (reason) {
								case 'breakpoint-hit': {
									const bkpt	= +record.bkptno;
									const log	= this.logBreakpoints[bkpt];
									if (log)
										this.printLogPoint(log, {}).then(msg => this.sendEvent(new Adapter.OutputEvent({category: 'console', output: msg})));
									this.sendStopped('breakpoint', threadId, allStopped);
									break;
								}
								case 'watchpoint-trigger':
									this.sendStopped('data breakpoint', threadId, allStopped, "Modified!");
									break;

								case 'end-stepping-range':
									this.sendStopped('step', threadId, allStopped);
									break;

								case 'function-finished':
									this.sendStopped('step-out', threadId, allStopped);
									break;

								case 'exited-normally':
									this.sendCommand('quit');
									this.sendEvent(new Adapter.TerminatedEvent);
									break;

								case 'signal-received':
									if (!this.ignorePause) {
										if (record['signal-meaning'] === 'Interrupt') {
											this.sendStopped('pause', threadId, allStopped);
										} else {
											this.lastException = new DebuggerException(record['signal-name'], record['signal-meaning']);
											this.sendStopped('exception', threadId, allStopped, record['signal-name']);
										}
									}
									this.stopped.fire();
									break;

								case 'solib-event':
									// This event will only be hit if the user has explicitly specified a set of shared libraries for deferred symbol loading
									this.sharedLibraries.forEach((library: string) => {
										if (this.loadedLibraries[library]) {
											this.sendCommand(`sharedlibrary ${library}`);
											// Do not load shared libraries more than once
											// This is more of a standing hack, and should be revisited with a more robust solution as a shared
											// library could be closed by the inferior and need to be reloaded again (i.e. we must add it back)
											delete this.loadedLibraries[library];
										}
									});

									this.continue();
									break;

								default:
									throw new Error('Unknown stop reason');
							}
							break;
						}

						case 'running': {
							const threadId = record['thread-id'];
							if (threadId === 'all' || this.threadId === +threadId) {
								this.sendEvent(new Adapter.ContinuedEvent({threadId: this.threadId, allThreadsContinued: threadId === 'all'}));
								this.threadId			= -1;
								this.inferiorRunning	= true;
								// When the inferior resumes execution, remove all tracked variables which were used to service variable reference IDs
								this.clearVariables();
								this.stopped.reset();
							}
							break;
						}
					}
					break;

				case MI.RecordType.NOTIFY:
					switch (record.$class) {
						case 'thread-created':
							this.sendEvent(new Adapter.ThreadEvent({reason: 'started', threadId: +record.id}));
							break;

						case 'thread-exited':
							this.sendEvent(new Adapter.ThreadEvent({reason: 'exited', threadId: +record.id}));
							break;

						case 'breakpoint-modified': {
							const b = record.bkpt;
							this.sendEvent(new Adapter.BreakpointEvent({reason: 'changed', breakpoint: {
								id:		+b.number,
								verified:	true,
								message:	`hitcount=${b.times}`,
							}}));

							const log = this.logBreakpoints[+b.number];
							if (log)
								this.printLogPoint(log, {hits: b.times}).then(msg => this.sendEvent(new Adapter.OutputEvent({category: 'console', output: msg})));

							break;
						}

						case 'library-loaded': {
							// If deferred symbol loading is enabled, check that the shared library loaded is in the user specified list
							const libLoaded = path.basename(record.id);
							if (this.sharedLibraries.includes(libLoaded))
								this.loadedLibraries[libLoaded] = true;
							this.sendEvent(new Adapter.ModuleEvent({reason: 'new', module: {
								id:				record.id,
								name: 			record['target-name'],
								symbolStatus:	record['symbols-loaded'],
								addressRange:	`${record.ranges[0].from}:${record.ranges[0].to}`
							}}));
							break;
						}
						case 'library-unloaded':
							this.sendEvent(new Adapter.ModuleEvent({reason: 'removed', module: {
								id:				record.id,
								name: 			record['target-name'],
							}}));
							break;

						default:
							console.log('Unhandled notify', record);
							break;
					}
					break;

				case MI.RecordType.STATUS:
					// TODO
					break;
			}

		} catch (error: any) {
			this.error(error);
			this.sendEvent(new Adapter.TerminatedEvent);
		}
	}

	public sendCommand<T = MI.Results>(command: string): Promise<T> {
		return new Promise((resolve, reject) => {
			++this.token;
			this.handlers[this.token] = record => {
				if (record.$class === 'error') {
					console.log(`${record.msg} : ${command}`);
					reject(record.msg);
				} else {
					resolve(record as T);
				}
			};
			this.sendServer(this.token + command);
		});
	}
	public async pause_while(callback:() => any) {
		if (this.inferiorRunning) {
			try {
				this.ignorePause = true;
				await this.sendCommand('-exec-interrupt');
				await this.stopped;
				return await callback();
			} finally {
				this.ignorePause = false;
				if (this.inferiorStarted)
					this.sendCommand('-exec-continue');
			}			
		} else {
			return await callback();
		}
	}

	public async capture_while(callback:() => Promise<unknown>) : Promise<string[]> {
		try {
			this.capture = [];
			await callback();
			return this.capture;
		} finally {
			this.capture = undefined;
		}
	}

	public sendConsoleCommand(command: string, frameId?: number): Promise<string[]> {
		return this.capture_while(() => this.sendCommand(`-interpreter-exec ${this.frameCommand(frameId)} console ${quoted(command)}`));
	}

	private async sendCommands(commands: string[]): Promise<void> {
		await Promise.all(commands.map(cmd => cmd && cmd[0] !== '#' && this.sendCommand(cmd.replace(/\\/g, '/'))));
	}

	private async printLogPoint(msg: string, args: Record<string, string>): Promise<string> {
		return await async_replace(msg, /{(.*?)}/g, async (match: RegExpExecArray) =>
			args[match[1]] || await this.evaluateExpression(match[1])
		);
	}

	private async clearBreakPoints(breakpoints: Record<string, number>) {
		await Promise.all(Object.values(breakpoints).map((num: number) => this.sendCommand(`-break-delete ${num}`)));
	}

	public async evaluateExpression(expression: string, frameId?: number): Promise<string> {
		const response = await this.sendCommand(`-data-evaluate-expression ${this.frameCommand(frameId)} ${quoted(expression)}`);
		return response.value;
	}

	private findVariable(expression: string): Variable | undefined {
		for (const i in this.variables) {
			if (this.variables[i].name === expression)
				return this.variables[i];
		}
	}

	private async clearVariables(): Promise<void> {
		await Promise.all(Object.values(this.variables).map(v => this.sendCommand(`-var-delete ${v.debuggerName}`)));
		this.variables = [];
	}

	public async createVariable(expression: string, frameId?: number): Promise<Variable> {
		const v	= await this.sendCommand<MI.CreateVariable>(`-var-create ${this.frameCommand(frameId)} - * ${quoted(expression)}`);

		const variable = {
			name:			expression,
			debuggerName:	v.name,
			referenceID:	0,
			value:			v.value,
			type:			v.type,
		};

		if (+v.numchild || +v.dynamic || +v.has_more) {
			const ref = this.variables.length || 1;
			variable.referenceID	= ref;
			this.variables[ref]		= variable;
		}
		return variable;
	}

	private async realChildren(name: string) {
		const result	= await this.sendCommand<MI.ListChildren>(`-var-list-children --simple-values "${name}"`);
		let children: Variable[] = [];

		// Safety check
		if (parseInt(result.numchild)) {
			const pending: Promise<Variable[]>[] = [];

			result.children.forEach(([_, child]) => {
				if (!child.type && !child.value) {
					// this is a pseudo child on an aggregate type such as private, public, protected, etc
					// traverse into child and annotate its consituents with such attribute for special treating by the front-end
					// Note we could have mulitple such pseudo-levels at a given level
					pending.push(this.realChildren(child.name));

				} else {
					children.push({
						name:			child.exp,
						debuggerName:	child.name,
						referenceID:	+child.numchild || (+child.dynamic && child.displayhint !== 'string') ? 1 : 0, // TODO: hacky -- revisit this
						value:			child.value || '',
						type:			child.type,
					});
				}
			});
			(await Promise.all(pending)).forEach(variables => { children = [...children, ...variables];});
		}
		return children;
	}


	private async fetchChildren(variable: Variable) : Promise<DebugProtocol.Variable[]> {
		const children = await this.realChildren(variable.debuggerName);

		if (!variable.children) {
			variable.children = {};
			children.forEach(child => {
				variable.children![child.name] = child;
				if (child.referenceID) {
					const ref = this.variables.length || 1;
					child.referenceID	= ref;
					this.variables[ref]	= child;
				}
			});
		}

		return children.map((child): DebugProtocol.Variable => ({
			name:				child.name,
			value:				child.value,
			type:				child.type,
			variablesReference:	child.referenceID,
			memoryReference:	memoryReference(child.value)
		}));
	}

	private async fetchLocals(frameId: number) : Promise<DebugProtocol.Variable[]> {
		const result	= await this.sendCommand<MI.StackVariables>(`-stack-list-variables ${this.frameCommand(frameId)} --no-frame-filters --all-values`);

		return Promise.all(result.variables.map(async (child): Promise<DebugProtocol.Variable> => {
			let refId = 0;
			if (!child.value || isCompositeValue(child.value)) {
				const variable = this.findVariable(child.name) || await this.createVariable(child.name, frameId);
				refId = variable.referenceID;
			}
			return {
				name:				child.name,
				value:				child.value ?? '',
				type:				child.type,
				variablesReference:	refId,
				memoryReference:	child.value ? memoryReference(child.value) : undefined
			};
		}));
	}

	protected async disassemble(memoryAddress: string, instructionCount?: number) : Promise<MI.Disassemble> {

		const dis1 = async () => {try {
			return await this.sendCommand<MI.Disassemble>(`-data-disassemble -a ${memoryAddress} -- 0`);
		} catch (e) {
			return undefined;
		}};
		const dis2 = async (count: number) => {
			return await this.sendCommand<MI.Disassemble>(`-data-disassemble -s ${memoryAddress} -e "${memoryAddress}+${count}" -- 0`);
		};

		return instructionCount ? await dis2(instructionCount) : await dis1() ?? await dis2(256);
	}

	protected remoteSource(path: string) : number {
		if (path in this.remoteSources)
			return this.remoteSources[path];

		return this.remoteSources[path] = this.sources.push(async () => {
			const capture = await this.capture_while(async () => this.sendCommand(`-interpreter-exec console "list ${path}:1,1000"`));
			return capture.map(line => line.substring(line.indexOf('\t') + 1)).join('');
		});
	}

	//-----------------------------------
	// Adapter handlers
	//-----------------------------------

	protected async launchRequest(args: LaunchRequestArguments) {
		const match = args.debugger && /^(?:remote:(.*?):(\d+))|(?:process:(\d+))/.exec(args.debugger);
		if (match) {
			if (match[1]) {
				// remote:host:port
				const options = {
					host: match[1],
					port: +match[2],
				};

				const client = new net.Socket();
				await new Promise<void>(resolve => {
					client.connect(options, () => resolve());
					client.on('error', err => {
						this.error(`${err}`);
						this.sendEvent(new Adapter.TerminatedEvent);
					});
					client.on('close', () => {
						this.sendEvent(new Adapter.OutputEvent({category: 'console', output: 'GDB has exited'}));
						this.sendEvent(new Adapter.TerminatedEvent);
					});
				});
				this.setCommunication(client, client);

			} else if (match[3]) {
				//process:id
				const gdb = processes.connect(+match[3]);
				if (gdb) {
					this.setCommunication(gdb.stdin, gdb.stdout, gdb.stderr);
					gdb.stdin.write('hello\n');
				}
			}

		} else {
			const gdb = spawn(args.debugger || 'gdb', [...args.debuggerArgs || [], '--interpreter=mi', '-q'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				cwd: args.cwd,
				env: args.env
			}).on('error', err => {
				this.error(`${err}`);
				this.sendEvent(new Adapter.TerminatedEvent);
			}).on('close', () => {
				this.sendEvent(new Adapter.OutputEvent({category: 'console', output: 'GDB has exited'}));
				this.sendEvent(new Adapter.TerminatedEvent);
			});
			this.setCommunication(gdb.stdin, gdb.stdout, gdb.stderr);
		}

		if (args.startupCmds?.length)
			await this.sendCommands(args.startupCmds);

		this.ready.fire();
		await Promise.all(this.startupPromises);
	}

	protected async configurationDoneRequest(_args: DebugProtocol.ConfigurationDoneArguments) {
		// registers
		this.registers = new Registers(this);

		// postload
		let postLoadCommands = this.postLoadCommands;

		if (this.sharedLibraries.length) {
			postLoadCommands = [
				'-gdb-set stop-on-solib-events 1',
				'-gdb-set auto-solib-add off',
				...this.sharedLibraries.map(library => `sharedlibrary ${library}`),
				...postLoadCommands
			];

		} else {
			const result = await this.sendCommand('-gdb-show auto-solib-add');
			if (result.value !== 'off')
				postLoadCommands = [
					'sharedlibrary',
					...postLoadCommands
				];
		}

		await this.sendCommands(postLoadCommands);
		this.inferiorStarted = true;

		if (!this.inferiorRunning)
			this.sendEvent(new Adapter.StoppedEvent({reason: "startup", allThreadsStopped: true, text: "You probably need a 'continue' in the postLoadCmds"}));

		this.globals = new Globals(this);
	}

	protected async disconnectRequest(_args: DebugProtocol.DisconnectArguments) {
		await this.sendCommands([...this.terminateCommands, '-gdb-exit']);
	}

	protected async sourceRequest(args: DebugProtocol.SourceArguments) {
		const content = await this.sources[args.sourceReference - 1]();
		return {content};
	}

	protected async stackTraceRequest(args: DebugProtocol.StackTraceArguments) {
		const result = await this.sendCommand<MI.ListFrames>(`-stack-list-frames --thread ${args.threadId}`);

		const stack = result.stack.map(([_, frame]): DebugProtocol.StackFrame => {
			let source: DebugProtocol.Source;
			if (frame.fullname) {
				let path = this.mapSource(frame.fullname);
				let sourceReference;
				if (path.startsWith('remote:')) {
					path			= path.substring(7);
					sourceReference	= this.remoteSource(path);
				}
				source = {
					name:	frame.file,
					path,
					sourceReference
				};
			} else {
				source = {
					name:				frame.addr,
					sourceReference:	this.sources.push(async () => (await this.disassemble(frame.addr)).asm_insns.map(inst => `${inst.address}: ${inst.inst}`).join('\n')),
					presentationHint:	'deemphasize',
				};
			}

			return {
				id:			this.frames.push({
					thread:		args.threadId,
					frame:		+frame.level,
					statics:	this.globals?.staticsIndex(frame.fullname) ?? -1
				}) - 1,
				name:		frame.func,
				source,
				line:		frame.line === undefined ? 1 : +frame.line,
				column:		0,
				instructionPointerReference: frame.addr
				};
		});

		return {
			stackFrames: stack,
			totalFrames: stack.length - 1,
		};
	}

	protected async scopesRequest(args: DebugProtocol.ScopesArguments) {
		const statics = this.frames[args.frameId].statics;
		return {
			scopes: [
				{
					name:				'Locals',
					variablesReference: SCOPE.LOCAL + args.frameId,
					expensive:			false,
					presentationHint:	'locals',
				},
				...(statics >= 0 ? [{
					name: 'Statics',
					variablesReference: SCOPE.STATICS + statics,
					expensive: true,
					presentationHint:	'globals',
				}] : []),
				{
					name: 'Globals',
					variablesReference:	SCOPE.GLOBALS,
					expensive:			true,
					presentationHint:	'globals',
				},
				{
					name: 'Registers',
					variablesReference:	SCOPE.REGISTERS,
					expensive:			true,
					presentationHint:	'registers',
				},
			],
		};
	}

	protected async completionsRequest(args: DebugProtocol.CompletionsArguments) {
		if (this.python)
			return;
		const record = await this.sendCommand(`-complete "${args.text}"`);
		return {targets: record.matches.map((match: string) => ({label: match}))};
	}

	protected async disassembleRequest(args: DebugProtocol.DisassembleArguments) {
		const result		= await this.disassemble(adjustMemory(args.memoryReference, args.offset), args.instructionCount);
		const instructions	= result.asm_insns.map(inst => ({
			address:		inst.address,
			instruction:	inst.inst,
			...(!+inst.offset && {symbol: inst['func-name']})
		}));
		return {instructions};
	}

	protected async readMemoryRequest(args: DebugProtocol.ReadMemoryArguments) {
		if (args.count === 0)
			return;

		const record	= await this.sendCommand(`-data-read-memory-bytes ${args.offset ? `-o ${args.offset}` : ''} ${args.memoryReference} ${args.count}`);
		const memory	= record['memory'] as MI.Memory[];
		const data		= memory && memory.length > 0 ? Buffer.from(memory[0].contents, 'hex').toString('base64'): '';

		return {
			address: memory[0].begin,
			data,
			//unreadableBytes: data ? +address - +memory[0].begin : args.count
		};
	}

	protected async writeMemoryRequest(args: DebugProtocol.WriteMemoryArguments) {
		const address	= adjustMemory(args.memoryReference, args.offset);
		const data		= Buffer.from(args.data, 'base64').toString('hex');
		await this.sendCommand(`-data-write-memory-bytes ${address} ${data}`);
	}

	protected async threadsRequest() {
		const result	= await this.sendCommand<MI.ThreadInfo>('-thread-info');
		const threads	= result.threads.map(thread => ({id: +thread.id, name: thread.name ?? thread.id}));
		return {threads};
	}

	protected async nextRequest(args: DebugProtocol.NextArguments) {
		await this.sendCommand(`-exec-next${granularity(args.granularity)} --thread ${args.threadId}`);
	}

	protected async stepInRequest(args: DebugProtocol.StepInArguments) {
		await this.sendCommand(`-exec-step${granularity(args.granularity)} --thread ${args.threadId}`);
	}

	protected async stepOutRequest(args: DebugProtocol.StepOutArguments) {
		await this.sendCommand(`-exec-finish --thread ${args.threadId}`);
	}

	protected async stepBackRequest(args: DebugProtocol.StepBackArguments) {
			await this.sendCommand(`-exec-step${granularity(args.granularity)} --reverse --thread ${args.threadId}`);
	}

	protected async continueRequest(args: DebugProtocol.ContinueArguments) {
		this.ignorePause = false;
		await this.sendCommand(`-exec-continue --thread ${args.threadId}`);
		return {allThreadsContinued: true};
	}

	protected async reverseContinueRequest(args: DebugProtocol.ReverseContinueArguments) {
		this.ignorePause = false;
		await this.sendCommand(`-exec-continue --reverse --thread ${args.threadId}`);
		return {allThreadsContinued: true};
	}

	protected async pauseRequest(args: DebugProtocol.PauseArguments) {
		if (!this.inferiorRunning)
			await this.continue();
		await this.sendCommand(`-exec-interrupt ${args.threadId || ''}`);
	}

	protected async setBreakpointsRequest(args: DebugProtocol.SetBreakpointsArguments) {
		const filename		= args.source.path || '';
		const breakpoints	= args.breakpoints || [];
		const normalizedFileName =  filename;

		// There are instances where breakpoints won't properly bind to source locations despite enabling async mode on GDB.
		// To ensure we always bind to source, explicitly pause the debugger, but do not react to the signal from the UI side so as to not get the UI in an odd state

		const done = this.addStartup();
		await this.ready;

		return this.pause_while(async () => {
			if (this.breakpoints[filename]) {
				await Promise.all(this.breakpoints[filename].map(breakpoint => {
					if (this.logBreakpoints[breakpoint])
						delete this.logBreakpoints[breakpoint];
					return this.sendCommand(`-break-delete ${breakpoint}`);
				}));
				delete this.breakpoints[filename];
			}

			const confirmed:	DebugProtocol.Breakpoint[] = [];
			const ids:			number[] = [];

			try {
				await Promise.all(breakpoints.map(async b => {
					const record	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} -f ${normalizedFileName}:${b.line}`);
					const bkpt		= record.bkpt as MI.Breakpoint;
					if (bkpt) {
						confirmed.push({verified: !bkpt.pending, line: bkpt.line ? +bkpt.line : undefined});
						ids.push(+bkpt.number);

						if (b.logMessage)
							this.logBreakpoints[+bkpt.number] = b.logMessage;
					}
				}));
			} catch (e) {
				console.error(e);
			}
			done();

			// Only return breakpoints GDB has actually bound to a source; others will be marked verified as the debugger binds them later on
			this.breakpoints[filename] = ids;
			return {breakpoints: confirmed};
		});
	}

	protected async setExceptionBreakpointsRequest(args: DebugProtocol.SetExceptionBreakpointsArguments) {
		await this.ready;
		return this.pause_while(async () => {
			await this.clearBreakPoints(this.exceptionBreakpoints);
			this.exceptionBreakpoints = {};

			return Promise.all(args.filters.map(async type => {
				const record = await this.sendCommand(`-catch-${type}`);
				this.exceptionBreakpoints[type] = record.bkpt.number;
			}));
		});
	}

	protected async setFunctionBreakpointsRequest(args: DebugProtocol.SetFunctionBreakpointsArguments) {
		await this.ready;
		const breakpoints = await this.pause_while(async () => {
			await this.clearBreakPoints(this.functionBreakpoints);
			this.functionBreakpoints = {};

			return await Promise.all(args.breakpoints.map(async b => {
				const record	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} ${b.name}`);
				const bkpt		= record.bkpt as MI.Breakpoint;
				this.functionBreakpoints[b.name] = +bkpt.number;
				return {verified:!bkpt.pending, line: bkpt.line ? +bkpt.line : undefined};
			}));
		});

		return {breakpoints};
	}

	protected async dataBreakpointInfoRequest(args: DebugProtocol.DataBreakpointInfoArguments) {
		const refId		= args.variablesReference;
		let		dataId	= args.name;

		if (refId && refId !== SCOPE.GLOBALS) {
			const variable = this.variables[refId];
			if (variable && variable.children)
				dataId = variable.children[dataId].debuggerName;
		}

		return {
			dataId,
			description:	args.name,
			accessTypes:	['read', 'write', 'readWrite'] as DebugProtocol.DataBreakpointAccessType[],
			canPersist:		true
		};
	}

	protected async setDataBreakpointsRequest(args: DebugProtocol.SetDataBreakpointsArguments) {
		await this.ready;
		const breakpoints = await this.pause_while(async () => {
			await this.clearBreakPoints(this.dataBreakpoints);
			this.dataBreakpoints = {};

			return await Promise.all(args.breakpoints.map(async b => {
				const record	= await this.sendCommand(`-break-watch ${b.accessType === 'read' ? '-r' : b.accessType === 'readWrite' ? '-a' : ''} ${breakpointConditions(b.condition, b.hitCondition)} ${b.dataId}`);
				const bkpt		= record.wpt;
				this.dataBreakpoints[b.dataId] = bkpt.number;
				return {verified: !bkpt.pending};
			}));
		});

		return {breakpoints};
	}

	protected async setInstructionBreakpointsRequest(args: DebugProtocol.SetInstructionBreakpointsArguments)	{
		await this.ready;
		const breakpoints = await this.pause_while(async () => {
			//const newbps = Object.fromEntries(args.breakpoints.map(b => [adjustMemory(b.instructionReference, b.offset), b]));

			await this.clearBreakPoints(this.instsBreakpoints);
			this.instsBreakpoints = {};

			return await Promise.all(args.breakpoints.map(async b => {
				const name		= adjustMemory(b.instructionReference, b.offset);
				const record	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} *${name}`);
				const bkpt		= record.bkpt as MI.Breakpoint;
				this.instsBreakpoints[name] = +bkpt.number;
				return {verified: !bkpt.pending};
			}));
		});

		return {breakpoints};
	}

	protected async breakpointLocationsRequest(args: DebugProtocol.BreakpointLocationsArguments) {
		const record = await this.sendCommand(`-symbol-list-lines ${args.source.path}`);
		const lines = record.lines as MI.Line[];

		if (lines) {
			const filter = args.endLine
				? (line: MI.Line) => +line.line >= args.line && +line.line <= args.endLine!
				: (line: MI.Line) => +line.line === args.line;

			const breakpoints: DebugProtocol.BreakpointLocation[] = lines.filter(filter).map(line => ({line: +line.line}));
			return {breakpoints};
		}
	}

	protected async gotoTargetsRequest(args: DebugProtocol.GotoTargetsArguments) {
		const record = await this.sendCommand(`-symbol-list-lines ${args.source.path}`);
		const lines = record.lines as MI.Line[];

		if (lines) {
			const targets: DebugProtocol.GotoTarget[] = lines
				.filter(line => +line.line === args.line)
				.sort((a, b) => +a.pc - +b.pc)
				.filter((line, index, lines) => index === 0 || line.pc !== lines[index - 1].pc)
				.map(line => ({
					id:		+line.pc,	// The address we'll jump to
					label:	args.source?.name ?? '?',
					line:	+line.line,
					instructionPointerReference: line.pc
				}));
			return {targets};
		}

		return {targets: []};
	}

	protected async gotoRequest(args: DebugProtocol.GotoArguments) {
		await this.evaluateExpression(`$pc=0x${args.targetId.toString(16)}`);
		setTimeout(() => this.sendStopped('goto', args.threadId), 0);
	}

	protected async variablesRequest(args: DebugProtocol.VariablesArguments) {
		const refId = args.variablesReference;

		const variables = await (
			refId >=	SCOPE.REGISTERS	? this.registers?.fetchGroup(this, refId - SCOPE.REGISTERS)
		:	refId >=	SCOPE.STATICS	? this.globals?.fetchStatics(this, refId - SCOPE.STATICS)
		:	refId >=	SCOPE.LOCAL		? this.fetchLocals(refId - SCOPE.LOCAL)
		:	refId ===	SCOPE.GLOBALS	? this.globals?.fetchGlobals(this, args.start ?? 0, args.count)
		:	this.variables[refId]		? this.fetchChildren(this.variables[refId])
		:	undefined
		);

		if (variables)
			return {variables};
	}

	protected async setVariableRequest(args: DebugProtocol.SetVariableArguments) {
		const refId = args.variablesReference;
		const name = args.name;

		if (refId >= SCOPE.REGISTERS)
			return {value: await this.evaluateExpression(`$${name}=${args.value}`)};

		if (refId >= SCOPE.GLOBALS)
			return {value: await this.evaluateExpression(`${name}=${args.value}`)};

		if (refId >= SCOPE.LOCAL)
			return {value: await this.evaluateExpression(`${name}=${args.value}`, refId - SCOPE.LOCAL)};

		const variable = this.variables[refId];
		if (variable && variable.children) {
			const record = await this.sendCommand(`-var-assign ${variable.children[name].debuggerName} ${quoted(args.value)}`);
			return {value: record.value};
		}
	}

	protected async setExpressionRequest(args: DebugProtocol.SetExpressionArguments) {
		const value	= await this.evaluateExpression(`${args.expression}=${args.value}`, args.frameId);
		return {
			value,
			memoryReference:	memoryReference(value)
		};
	}

	protected async evaluateRequest(args: DebugProtocol.EvaluateArguments) {
		const expression = args.expression;

		switch (args.context) {
			case 'repl': {
				const evaluateLine = async (line: string, frameId?: number): Promise<string> =>  {
					if (this.python) {
						if (line === 'exit()') {
							this.python = false;
							return "Exited Python Interactive Mode";
						}
			
						if (line.endsWith(':') || line.startsWith(' ') || line.startsWith('\t')) {
							// Continue capturing multi-line constructs
							//	"	=> \"
							//	\	=> \\
							//	\"	=> \\"
							this.pythonCommand += line.replace(/\\/g, '\\\\').replace(/(?<!\\)"/g, '\\"') + '\\n';
							return '';
						}
			
						if (this.pythonCommand) {
							this.sendCommand(`py exec("${this.pythonCommand}")`);
							this.pythonCommand = '';
						}
						line = `py print(${line})`;
			
					} else {
						line = line.trim();
						if (line.startsWith('-')) {
							const record = await this.sendCommand(`${line} ${this.frameCommand(args.frameId)}`);
							delete record.$token;
							delete record.$type;
							delete record.$class;
							this.sendEvent(new Adapter.OutputEvent({category: 'console', output: JSON.stringify(record, undefined, 2)}));
							return '';
						}
			
						if (line && line[0] !== '#') {
							const re	= /(?:python-interactive|pi)(?:$|\s+(.*))/;
							const m		= line.match(re);
							if (m) {
								if (!m[1]) {
									this.python = true;
									this.pythonCommand = '';
									return "Entered Python Interactive Mode";
								}
								line = `py print(${m[1]})`;
							}
						}
					}
					return (await this.sendConsoleCommand(line, frameId)).join('');
				};

				let result = '';
				for (const line of expression.split('\n')) {
					if (line)
						result += await evaluateLine(line, args.frameId);
				}

				return {result, variablesReference: 0};
			}

			case 'watch':
			case 'hover': {
				const variable = this.findVariable(expression) || await this.createVariable(expression, args.frameId);
				return {
					result:				variable.value,
					variablesReference:	variable.referenceID,
					memoryReference:	memoryReference(variable.value),
				};
			}
		}
	}

	protected async modulesRequest(args: DebugProtocol.ModulesArguments) {
		const record = await this.sendCommand(`-file-list-shared-libraries`);
		if (record['shared-libraries']) {
			const modules = ((record['shared-libraries']) as MI.Module[]).map((module: MI.Module): DebugProtocol.Module => ({
				id:				module.id,
				name:			module['host-name'],
				path:			module['target-name'],
				symbolStatus:	+module['symbols-loaded'] ? 'loaded' : 'not loaded',
				addressRange:	module.ranges[0].from
			}));
			const start = args.startModule ?? 0;
			return {
				modules: 		args.moduleCount ? modules.slice(start, start + args.moduleCount) : modules.slice(start),
				totalModules:	modules.length
			};
		}
	}

	protected async loadedSourcesRequest(_args: DebugProtocol.LoadedSourcesArguments) {
		const record = await this.sendCommand(`-file-list-exec-source-files`);
		if (record['files']) {
			const sources = ((record['files']) as MI.SourceFile[]).map((source): DebugProtocol.Source => ({
				name:	source.file,
				path:	source.fullname,
			}));
			return {sources};
		}
	}

// TBD
	//protected async cancelRequest				(_args: DebugProtocol.CancelArguments)					{}
	//protected async runInTerminalRequest		(_args: DebugProtocol.RunInTerminalRequestArguments)	{}
	//protected async startDebuggingRequest		(_args: DebugProtocol.StartDebuggingRequestArguments)	{}
	//protected async attachRequest				(_args: DebugProtocol.AttachRequestArguments)	        {}
	//protected async restartRequest			(_args: DebugProtocol.RestartArguments)					{}
	//protected async terminateRequest			(_args: DebugProtocol.TerminateArguments)				{}
	//protected async restartFrameRequest		(_args: DebugProtocol.RestartFrameArguments)	        {}
	//protected async terminateThreadsRequest	(_args: DebugProtocol.TerminateThreadsArguments)        {}
	//protected async stepInTargetsRequest		(_args: DebugProtocol.StepInTargetsArguments)	        {}
	//protected async locationsRequest			(_args: DebugProtocol.LocationsArguments)				{}
}
