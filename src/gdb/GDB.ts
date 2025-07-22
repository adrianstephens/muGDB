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
	DisassemblyCache,
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

function python_escape(str: string): string {
	//	"	=> \"
	//	\	=> \\
	//	\"	=> \\"
	return str.replace(/\\/g, '\\\\').replace(/(?<!\\)"/g, '\\"') + '\\n';
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

function partition<T>(array: T[], predicate: (value: T) => boolean): T[][] {
	const result: T[][] = [];
	array.forEach(value => (result[+predicate(value)] ??= []).push(value));
	return result;
}

function slice_count<T>(array: T[], start: number, count?: number) {
	return count === undefined ? array.slice(start) : array.slice(start + count);
}


function parseGdbTable(lines: string[]): Record<string, string>[] {
	if (lines.length === 0)
		return [];

	// Find header line and determine column positions
	const headerLine = lines[0];
	const columns: {name: string, col: number}[] = [];

	// Find positions where there are 2+ spaces between words
	const headerRegex = /\S+\s{2,}/g;
	let match;
	while ((match = headerRegex.exec(headerLine)) !== null)
		columns.push({name: match[0].trim(), col: match.index});

	if (columns[0].col)
		columns.unshift({name: '0', col: 0});

	// Parse data rows
	const result: Record<string, string>[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		const row: Record<string, string> = {};

		for (let j = 0; j < columns.length; ++j)
			row[columns[j].name] = line.substring(columns[j].col, columns[j + 1]?.col).trim();

		result.push(row);
	}

	return result;
}


const modulePattern = /^(?:.*\/)?([^\/]+?)(?:\.[\d.]+)?$/;

function moduleName(name: string) {
	return name.match(modulePattern)?.[1] || name;
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

		const capture	= await gdb.captureConsoleCommandSync('maintenance print register-groups');
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

		const record	= await gdb.sendCommand<MI.Registers>(`-data-list-register-values r ${bitlist(group.includes).map(i => i.toString()).join(' ')}`);
		return [
			...children,
			...record['register-values'].map(reg => ({
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
	private statics:	Global[][] = [];
	private indices:	Record<string, number> = {};
	private ready:		Promise<void>;

	constructor(gdb: GDB) {
		this.ready = this.init(gdb);
	}
	private async init(gdb: GDB) {
		const record	= await gdb.sendCommand<MI.Symbols>(`-symbol-info-variables`);

		//Object.values(this.statics).forEach((file, i) => {
		//	file.index = i;
		//	file.symbols.sort((a, b) => a.name < b.name ? -1 : 1);
		//});

		this.globals	= record.symbols.debug.map(file => file.symbols
			.filter(sym => !sym.description.startsWith('static '))
			.map(sym => ({
				name:	sym.name,
				type:	sym.type,
			}))
		).flat().sort((a, b) => a.name < b.name ? -1 : 1);

		const temp	= record.symbols.debug.map(file => ({
			filename: file.fullname,
			symbols:	file.symbols
				.filter(sym => sym.description.startsWith('static ')).map(sym => ({
					name: sym.name,
					type: sym.type
				}))
			})
		).filter(statics => statics.symbols.length);

		this.indices	= Object.fromEntries(temp.map((statics, i) => [statics.filename, i]));
		this.statics	= temp.map(statics => statics.symbols);
	}

	private static async fetch(gdb: GDB, globals: Global[]) {
		return (await Promise.all(globals.map(async (g): Promise<DebugProtocol.Variable | undefined> => {
			try {
				const	value	= await gdb.evaluateExpression(g.name);
				let		refId	= 0;
				if (isCompositeValue(value)) {
					const v	= await gdb.createVariable(g.name);
					refId = v.referenceID;
				}
				return {
					name:					g.name,
					value,
					type:					g.type,
					variablesReference:	refId,
					memoryReference:		memoryReference(value)
				};
			} catch (_) {
				//
			}
		}))).filter(v => v) as DebugProtocol.Variable[];
	}

	async fetchGlobals(gdb: GDB, start: number, count?: number): Promise<DebugProtocol.Variable[]> {
		await this.ready;
		const globals = slice_count(this.globals, start, count);
		return Globals.fetch(gdb, globals);
	}
	async fetchStatics(gdb: GDB, id: number): Promise<DebugProtocol.Variable[]> {
		return Globals.fetch(gdb, this.statics[id]);
	}
	staticsIndex(fullname: string) {
		return this.indices[fullname] ?? -1;
	}
}

//-----------------------------------------------------------------------------
//	GDB
//-----------------------------------------------------------------------------

interface Variable {
	debuggerName:	string;	// The unique "name" assigned by the underlying MI debugger need not be identical to the actual source location name
	evaluateName:	string;	// The full expression
	value:			string;
	type:			string;
	numIndexed:		number;
	referenceID:	number;	// 0 if no children
	children?:		Record<string, Variable>;
}

interface Mapping {
	start:	string;
	end:	string;
	offset:	string;
	perms:	string;
}

function fixName(name: string) {
	return /^\d/.test(name) ? `[${name}]` : name;
}

export class GDB extends DebugSession {
	private parser = new MI.Parser();

	// Libraries for which debugger has loaded debug symbols for
	private	loadedLibraries: Record<string, boolean> = {};

	private	token = 0;
	private	handlers: {[token: number]: (record: MI.ResultRecord) => void} = [];

	private breakpoints:			Record<string, number[]> = {};
	private logBreakpoints:			Record<number, string> = {};
	private functionBreakpoints:	Record<string, number> = {};
	private exceptionBreakpoints:	Record<string, number> = {};
	private dataBreakpoints:		Record<string, number> = {};
	private instrBreakpoints:		Record<string, number> = {};

	private globals?:			Globals;
	private registers?:			Registers;
	private	discache			= new DisassemblyCache;
	private modcache?:			Promise<Record<string, Mapping[]>>;

	private variables:			Variable[] = [];
	private threads:			DebugProtocol.StackFrame[][] = [];
	private frames:				{thread: number, frame: number, statics: number}[] = [];
	private sources:			(() => Promise<string>)[] = [];
	private remoteSources:		Record<string, number> = {};

	private threadId			= -1;
	private inferiorStarted		= false;
	private inferiorRunning		= false;
	private python				= false;
	private buildingCommand: string | undefined;
	private ignorePause			= false;
	private stopped				= new DeferredPromise(true);
	private ready				= new DeferredPromise(false);
	private startupPromises: Promise<void>[] = [];

	// when set, capture debugger output lines
	private capture?:	string[];
	// lock for captureConsoleCommand to prevent overlapping calls
	private captureLock = Promise.resolve();

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
		this.threads	= [];
		this.frames		= [];
	}

	private continue() {
		this.ignorePause = false;
		return this.sendCommand('-exec-continue');
	}

	private terminate(restart = false) {
		this.sendEvent(new Adapter.TerminatedEvent({restart}));
		const term = MI.MakeError('terminated',	'-1');
		for (const i in this.handlers)
			this.handlers[i](term);
	}

	protected recvServer(line: string): void {
		try {
			const record = this.parser.parse(line);
			if (!record)
				return;

			switch (record.$type) {
				case MI.RecordType.CONSOLE:
					if (this.capture)
						this.capture.push(record.cstring);
					else if (record.cstring.startsWith('!@CAPTURE@!'))
						this.capture = [record.cstring.substring(11)];
					else
						this.sendEvent(new Adapter.OutputEvent({category: 'console', output: record.cstring}));
					break;

				case MI.RecordType.TARGET:
					this.sendEvent(new Adapter.OutputEvent({category: 'stdout', output: record.cstring}));
					break;

				case MI.RecordType.LOG:
					if (record.cstring.includes('internal-error'))
						this.terminate(!this.inferiorStarted);
					if (!this.capture) {
						this.sendEvent(new Adapter.OutputEvent({category: 'log', output: record.cstring}));
					}
					break;

				case MI.RecordType.RESULT:
					if (!record.$token) {
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
										this.logSubstitute(log[0], {}).then(msg => this.sendEvent(new Adapter.OutputEvent({category: 'console', output: msg})));
									this.sendStopped('breakpoint', threadId, allStopped);
									break;
								}
								case 'watchpoint-trigger':
								case 'access-watchpoint-trigger':
								case 'read-watchpoint-trigger':
									this.sendStopped('data breakpoint', threadId, allStopped, "Modified!");
									break;

								case 'end-stepping-range':
									this.sendStopped('step', threadId, allStopped);
									break;

								case 'function-finished':
									this.sendStopped('step-out', threadId, allStopped);
									break;

								case 'exited':
								case 'exited-normally':
									this.sendCommand('quit');
									this.terminate();
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
								id:			+b.number,
								verified:	true,
								message:	`hitcount=${b.times}`,
							}}));

							const log = this.logBreakpoints[+b.number];
							if (log && log[0] === '!')
								this.logSubstitute(log, {hits: b.times}).then(msg => this.sendEvent(new Adapter.OutputEvent({category: 'console', output: msg})));

							break;
						}

						case 'library-loaded': {
							// If deferred symbol loading is enabled, check that the shared library loaded is in the user specified list
							const libLoaded = path.basename(record.id);
							if (this.sharedLibraries.includes(libLoaded))
								this.loadedLibraries[libLoaded] = true;

							this.convertModule(record).then(module => this.sendEvent(new Adapter.ModuleEvent({reason: 'new', module})));

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
			this.terminate();
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

	public async captureConsoleCommand(command: string, frameId?: number): Promise<string[]> {
		let releaseLock: () => void;
		const previousLock = this.captureLock;
		this.captureLock = new Promise<void>(resolve => { releaseLock = resolve; });

		try {
			await previousLock;
			this.capture = [];
			await this.sendCommand(`-interpreter-exec ${this.frameCommand(frameId)} console ${quoted(command)}`);
			return this.capture;
		} finally {
			this.capture = undefined;
			releaseLock!();
		}
	}

	public async captureConsoleCommandSync(command: string, frameId?: number): Promise<string[]> {
		let releaseLock: () => void;
		const previousLock = this.captureLock;
		this.captureLock = new Promise<void>(resolve => { releaseLock = resolve; });

		try {
			await previousLock;
			await this.sendCommand(`-interpreter-exec ${this.frameCommand(frameId)} console ${quoted(`python print("!@CAPTURE@!" + gdb.execute(${quoted(command)}, to_string=True))`)}`);
			return this.capture!.map(i => i.split('\n')).flat();
		} finally {
			this.capture = undefined;
			releaseLock!();
		}
	}

	private async sendCommands(commands: string[]): Promise<void> {
		let building: string | undefined;
		let python = false;

		for (let line of commands) {
			if (building !== undefined) {
				if (line === 'end') {
					if (python) {
						await this.sendCommand(`py exec("${building}")`);
					} else {
						this.sendServer(building + '\nend');
					}
					building = undefined;
				} else {
					building += python ? python_escape(line) : '\n' + line;
				}
			} else {
				line = line.trim().replace(/\\/g, '/');
				if (line && line[0] !== '#') {
					if (line.match(/^python$|((if|while|define)\s+(.*))/)) {
						python		= line === 'python';
						building	= python ? '' : line;
					} else if (line[0] === '!') {
						try {
							await this.sendCommand(line.slice(1));
						} catch (e) {
							this.sendEvent(new Adapter.OutputEvent({category: 'console', output: `${e} ignored`}));
						}
					} else {
						await this.sendCommand(line);
					}
				}
			}
		}

		if (python && building)
			await this.sendCommand(`py exec("${building}")`);
	}

	public async evaluateExpression(expression: string, frameId?: number): Promise<string> {
		const response = await this.sendCommand<MI.Value>(`-data-evaluate-expression ${this.frameCommand(frameId)} ${quoted(expression)}`);
		return response.value;
	}

	private async logSubstitute(msg: string, args: Record<string, string>): Promise<string> {
		if (msg[0] === '!')
			msg = msg.slice(1);

		if (msg[0].startsWith("/py "))
			return (await this.captureConsoleCommand(`py exec("print(${msg.slice(4)})")`)).join(' ');

		return await async_replace(msg, /{(.*?)}/g, async (match: RegExpExecArray) =>
			args[match[1]] || await this.evaluateExpression(match[1])
		);
	}

	private async clearBreakPoints(key: string) {
		const breakpoints: Record<string, number> = (this as any)[key];
		(this as any)[key] = [];
		await Promise.all(Object.values(breakpoints).map((num: number) => this.sendCommand(`-break-delete ${num}`)));
	}

	private async clearVariables(): Promise<void> {
		const variables = this.variables;
		this.variables = [];
		await Promise.all(Object.values(variables).map(v => !v.debuggerName.includes('.') && this.sendCommand(`-var-delete ${v.debuggerName}`)));
	}

	public async createVariable(expression: string, frameId?: number): Promise<Variable> {
		const v		= await this.sendCommand<MI.CreateVariable>(`-var-create ${this.frameCommand(frameId)} - * ${quoted(expression)}`);
		const ref	= this.variables.length || 1;

		const variable = {
			debuggerName:	v.name,
			evaluateName:	expression,
			numIndexed:		v.type.endsWith(']') ? +v.numchild : 0,
			referenceID:	+v.numchild || v.dynamic || +v.has_more ? ref : 0,
			value:			v.value,
			type:			v.type,
		};

		return this.variables[ref] = variable;
	}

	private async getVariable(expression: string, frameId?: number): Promise<Variable> {
		for (const i in this.variables) {
			if (this.variables[i].evaluateName === expression)
				return this.variables[i];
		}
		return await this.createVariable(expression, frameId);
	}

	private async fetchChildren(variable: Variable, start?: number, count?: number) : Promise<DebugProtocol.Variable[]> {
		if (count) {
			return await Promise.all(Array.from({length: count}, async (_, i): Promise<DebugProtocol.Variable> => {
				const index		= (start ?? 0) + i;
				return {
					name:	`[${index}]`,
					value:	await this.evaluateExpression(`(${variable.evaluateName})[${index}]`),
					variablesReference: 0,
				};
			}));

		} else {

			const realChildren = async (name: string): Promise<MI.ChildVariable[]> => {
				const result	= await this.sendCommand<MI.Children>(`-var-list-children --simple-values "${name}"`);
				const parts		= partition(result.children.map(([_, child]) => child), child => !child.type && !child.value);
				return [
					...(parts[0] ? parts[0] : []),
					...(parts[1] ? (await Promise.all(parts[1].map(child => realChildren(child.name)))).flat() : [])
				];
			};

			const children 	= await realChildren(variable.debuggerName);

			if (!variable.children) {
				variable.children = {};
				children.forEach(child => {
					const evaluateName	= child.exp[0] === '*'		? '*' + variable.evaluateName
										: /^\d/.test(child.exp) 	? `${variable.evaluateName}[${child.exp}]`
										: variable.evaluateName + '.' + child.exp;
				
					const referenceID = +child.numchild || child.displayhint === 'string' ? this.variables.length || 1 : 0; // TODO: hacky -- revisit this

					const childvar = {
						debuggerName:	child.name,
						evaluateName,
						numIndexed:		child.type.endsWith(']') ? +child.numchild : 0,
						referenceID,
						value:			child.value || '',
						type:			child.type,
					};

					variable.children![fixName(child.exp)] = childvar;
					if (referenceID)
						this.variables[referenceID]	= childvar;
				});
			}

			return children.map((child): DebugProtocol.Variable => {
				const childvar	= variable.children![child.exp];
				return {
					name:				fixName(child.exp),
					value:				child.value ?? '',
					type:				child.type,
					variablesReference:	childvar.referenceID,
					indexedVariables:	childvar.numIndexed,
					memoryReference:	memoryReference(child.value),
					evaluateName:		childvar.evaluateName
				};
			});
		}
	}

	private async fetchLocals(frameId: number) : Promise<DebugProtocol.Variable[]> {
		const result	= await this.sendCommand<MI.StackVariables>(`-stack-list-variables ${this.frameCommand(frameId)} --no-frame-filters --all-values`);

		return Promise.all(result.variables.map(async (child): Promise<DebugProtocol.Variable> => {
			let refId = 0;
			if (!child.value || isCompositeValue(child.value)) {
				const variable = await this.getVariable(child.name, frameId);
				refId = variable.referenceID;
			}
			return {
				name:				child.name,
				value:				child.value ?? '',
				type:				child.type,
				variablesReference:	refId,
				memoryReference:	child.value ? memoryReference(child.value) : undefined,
				evaluateName:		child.name
			};
		}));
	}

	protected remoteSource(path: string) : number {
		if (path in this.remoteSources)
			return this.remoteSources[path];

		return this.remoteSources[path] = this.sources.push(async () => {
			const capture = await this.captureConsoleCommandSync(`list ${path}:1,1000`);
			return capture.map(line => line.substring(line.indexOf('\t') + 1)).join('');
		});
	}

	protected async getExecutable(): Promise<DebugProtocol.Module | undefined> {
		const table	= parseGdbTable(await this.captureConsoleCommandSync('info inferiors'));

		// Find the active inferior (marked with *)
		const active = table.find(row => row[0] === '*');
		if (active && active.Executable) {
			const mem	= await this.getModuleMemory(moduleName(active.Executable));

			return {
				id:				'0',
				name:			path.basename(active.Executable),
				path: 			active.Executable,
				symbolStatus:	'loaded',
				addressRange:	mem ? `${mem[0].start}:${mem.at(-1)!.end}` : undefined
			};
		}
	}

	async getModuleMemory(name: string): Promise<Mapping[] | undefined> {
		if (this.modcache) {
			const map	= (await this.modcache)[name];
			if (map)
				return map;
		}
		this.modcache = this.captureConsoleCommandSync('info proc mappings').then(mappings => {
			const result: Record<string, Mapping[]> = {};
			for (const i of mappings.map(line => line.trim().split(/\s+/)).filter(parts => parts.length > 5 && parts[0].startsWith('0x'))) {
				(result[moduleName(i[5])] ??= []).push({
					start: i[0],
					end:	i[1],
					offset:	i[3],
					perms:	i[4]
				});
			}
			return result;
		});

		return (await this.modcache)[name];
	}

	protected async convertModule(record: MI.Module) : Promise<DebugProtocol.Module> {
		const mem	= await this.getModuleMemory(moduleName(record['host-name']));

		return {
			id:				record.id,
			name:			record['host-name'],
			path:			record['target-name'],
			symbolStatus:	+record['symbols-loaded'] ? 'loaded' : 'not loaded',
			addressRange:	mem ? `${mem[0].start}:${mem.at(-1)!.end}` : `${record.ranges[0].from}:${record.ranges[0].to}`
		};
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
						this.terminate();
					});
					client.on('close', () => {
						this.sendEvent(new Adapter.OutputEvent({category: 'console', output: 'GDB has exited'}));
						this.terminate();
					});
				});
				this.setCommunication(client, client);

			} else if (match[3]) {
				//process:pid
				const gdb = processes.connect(+match[3]);
				if (gdb) {
					this.setCommunication(gdb.stdin, gdb.stdout, gdb.stderr);
					gdb.stdin.write('hello\n');
				}
			}

		} else {
			const debuggerArgs = args.debuggerArgs || [];
/*
			const tty	= debuggerArgs.findIndex(s => s.startsWith('--tty='));
			if (tty >= 0) {
				const kind = debuggerArgs[tty].substring(6);
				if (kind === 'integrated' || kind === 'external') {
					try {
						const resp = await this.runInTerminalRequest({kind, cwd: '', args: ['bash']}, 100000);
						const dev = getTTYFromPid(resp.shellProcessId);
						console.log(dev);
						debuggerArgs[tty] = `--tty=${dev}`;
					} catch (e: any) {
						console.log(e);
					}
				}
			}
*/

			const i		= debuggerArgs.findIndex(s => s === '--args');
			debuggerArgs?.splice(i, 0, '--interpreter=mi', '-q');
			const gdb = spawn(args.debugger || 'gdb', debuggerArgs, {
			//const gdb = spawn(args.debugger || 'gdb', ['--interpreter=mi', '-q', ...args.debuggerArgs || []], {
				stdio: ['pipe', 'pipe', 'pipe'],
				cwd: args.cwd,
				env: args.env
			}).on('error', err => {
				this.error(`${err}`);
				this.terminate();
			}).on('close', () => {
				this.sendEvent(new Adapter.OutputEvent({category: 'console', output: 'GDB has exited'}));
				this.terminate();
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
		this.getExecutable().then(exec => exec && this.sendEvent(new Adapter.ModuleEvent({reason: 'new', module: exec})));
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
		let stack = this.threads[args.threadId];

		if (!stack) {
			const result = await this.sendCommand<MI.Stack>(`-stack-list-frames --thread ${args.threadId}`);

			stack = result.stack.map(([_, frame]): DebugProtocol.StackFrame => {
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
						sourceReference:	this.sources.push(async () => {
							let record;
							try {
								record = await this.sendCommand<MI.DisassembleNoSource>(`-data-disassemble -a ${frame.addr} -- 0`);
							} catch (_) {
								record = await this.sendCommand<MI.DisassembleNoSource>(`-data-disassemble -s ${frame.addr} -e "${frame.addr}+0x100" -- 0`);
							}
							return record.asm_insns.map(inst => `${inst.address}: ${inst.inst}`).join('\n');
						}),
						presentationHint:	'deemphasize',
					};
				}

				return {
					id:			this.frames.push({
						thread:		args.threadId,
						frame:		+frame.level,
						statics:	this.globals ? this.globals.staticsIndex(frame.fullname) : -1
					}) - 1,
					name:		frame.func,
					source,
					line:		frame.line === undefined ? 1 : +frame.line,
					column:		0,
					instructionPointerReference: frame.addr
				};
			});

			this.threads[args.threadId] = stack;
		}
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
		if (!this.python) {
			const record = await this.sendCommand(`-complete "${args.text}"`);
			return {targets: record.matches.map((match: string) => ({label: match}))};
		}
	}

	protected async disassembleRequest(args: DebugProtocol.DisassembleArguments) {

		const Insn = (i: MI.Instruction) => ({
			address:		i.address,
			instruction:	i.inst,
			...(!+i.offset && {symbol: i['func-name']})
		});

		const sourceInsns = (record: MI.DisassembleSource) => record.asm_insns.map(([_, j]) => {
			const common = {
				location: {
					name: j.file,
					path: j.fullname
				},
				line: 	+j.line
			};
			return j.line_asm_insn.map((i): DebugProtocol.DisassembledInstruction => ({
				...Insn(i),
				...common
			}));
		}).flat();

		const Insns = (record: MI.Disassemble) => MI.hasSource(record)
			? sourceInsns(record)
			: record.asm_insns.map(i => Insn(i));

		let ins0: DebugProtocol.DisassembledInstruction[] = [];
		let ins1: DebugProtocol.DisassembledInstruction[] = [];
		let	offset0 = 0, offset1 = 0, bpi = 1;

		const cached	= this.discache.get(adjustMemory(args.memoryReference, args.offset), args.instructionOffset ?? 0);
		const address	= cached.address;

		let ibegin		= cached.ibegin;
		if (cached.skip < 0) {
			const record	= await this.sendCommand<MI.Disassemble>(`-data-disassemble -s "${address}-${-cached.skip}" -e ${address} --source`);
			ins0			= Insns(record);
			ibegin	-= ins0.length;
		}

		while (ins0.length < -ibegin) {
			let record = await this.sendCommand<MI.Disassemble>(`-data-disassemble -s "${address}-${-offset0 + Math.ceil(-(ins0.length + ibegin) * bpi)}" -e "${address}-${-offset0}" --source`);
			// if we get MI.Disassemble; skip first instruction (if any)
			if (!MI.hasSource(record)) {
				if (record.asm_insns.length < 2) {
					bpi *= 2;
					continue;
				}
				const func = record.asm_insns[0]['func-name'];
				const first = func
					? record.asm_insns.find(i => i['func-name'] !== func)
					: record.asm_insns[1];

				if (!first)
					break;

				record = await this.sendCommand<MI.DisassembleSource>(`-data-disassemble -s ${first.address} -e "${address}-${-offset0}" --source`);
			}
			const ins = sourceInsns(record);
			ins0	= [...ins, ...ins0];
			offset0	= +ins[0].address - +address;
			const n	= ins0.length;
			bpi		= n ? -offset0 / n : bpi * 2;
		}

		const iend		= args.instructionCount + ibegin;
		while (ins1.length < iend) {
			let record = await this.sendCommand<MI.Disassemble>(`-data-disassemble -s "${address}+${offset1}" -e "${address}+${Math.ceil((iend + 1) * bpi)}" --source`);
			if (!MI.hasSource(record)) {
				if (record.asm_insns.length < 2) {
					bpi *= 2;
					continue;
				}
				if (!record.asm_insns[0]['func-name']) {
					ins1.push(Insn(record.asm_insns[0]));
					record = await this.sendCommand<MI.Disassemble>(`-data-disassemble -s ${record.asm_insns[1].address} -e "${address}+${Math.ceil((iend + 1) * bpi)}" --source`);
				}
			}
			const ins	= Insns(record);
			if (ins.length < 2) {
				bpi *= 2;
				continue;
			}
			const last	= ins.pop(); 
			ins1	= [...ins1, ...ins];
			offset1	= +last!.address - +address;

			const n	= ins1.length;
			bpi		= n ? offset1 / n : bpi * 2;
		}

		const a = cached.idiff / 100;
		const b = cached.idiff % 100;
		for (let i = 1; i * 100 - b < ins0.length; i++)
			this.discache.set(cached.base, a - i, ins0.at(b - i * 100)!.address);
		for (let i = 0; i * 100 + b < ins1.length; i++)
			this.discache.set(cached.base, a + i, ins1[b + i * 100].address);

		if (iend > 0)
			ins1 = ins1.slice(0, iend);
		if (ibegin < 0)
			ins1 = [...ins0.slice(ins0.length + ibegin), ...ins1];
		else
			ins1 = ins1.slice(ibegin);

		return {instructions: ins1};
	}

	protected async readMemoryRequest(args: DebugProtocol.ReadMemoryArguments) {
		if (args.count === 0)
			return;

		const record	= await this.sendCommand<MI.MemoryReadBytes>(`-data-read-memory-bytes ${args.offset ? `-o ${args.offset}` : ''} ${args.memoryReference} ${args.count}`);
		if (record.memory && record.memory.length > 0) {
			const memory	= record.memory[0];
			return {
				address: memory.begin,
				data:	Buffer.from(memory.contents, 'hex').toString('base64')
				//unreadableBytes: data ? +address - +memory[0].begin : args.count
			};
		}
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
		if (args.breakpoints) {
			const filename		= args.source.path || '';
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

				const results = (await Promise.all(args.breakpoints!.map(async b => {
					try {
						const record	= await this.sendCommand<MI.BreakpointInsert>(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} -f ${normalizedFileName}:${b.line}`);
						if (b.logMessage)
							this.logBreakpoints[+record.bkpt.number] = b.logMessage;
						return record.bkpt;
					} catch (e) {
						console.error(e);
					}
				}))).filter(x => x) as MI.Breakpoint[];

				done();

				this.breakpoints[filename] = results.map(bkpt => +bkpt.number);

				// Only return breakpoints GDB has actually bound to a source; others will be marked verified as the debugger binds them later on
				const breakpoints = results.map(bkpt => ({verified: !bkpt.pending, line: bkpt.line ? +bkpt.line : undefined}));
				return {breakpoints};
			});
		}
	}

	protected async setExceptionBreakpointsRequest(args: DebugProtocol.SetExceptionBreakpointsArguments) {
		await this.ready;
		return this.pause_while(async () => {
			await this.clearBreakPoints('exceptionBreakpoints');

			return Promise.all(args.filters.map(async type => {
				const record = await this.sendCommand<MI.BreakpointInsert>(`-catch-${type}`);
				this.exceptionBreakpoints[type] = +record.bkpt.number;
			}));
		});
	}

	protected async setFunctionBreakpointsRequest(args: DebugProtocol.SetFunctionBreakpointsArguments) {
		await this.ready;
		const breakpoints = await this.pause_while(async () => {
			await this.clearBreakPoints('functionBreakpoints');

			return await Promise.all(args.breakpoints.map(async b => {
				const record	= await this.sendCommand<MI.BreakpointInsert>(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} ${b.name}`);
				const bkpt		= record.bkpt;
				this.functionBreakpoints[b.name] = +bkpt.number;
				return {verified:!bkpt.pending, line: bkpt.line ? +bkpt.line : undefined};
			}));
		});

		return {breakpoints};
	}

	protected async dataBreakpointInfoRequest(args: DebugProtocol.DataBreakpointInfoArguments) {
		const	refId	= args.variablesReference;
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
			await this.clearBreakPoints('dataBreakpoints');

			return await Promise.all(args.breakpoints.map(async b => {
				const record	= await this.sendCommand<MI.WatchpointInsert>(`-break-watch ${b.accessType === 'read' ? '-r' : b.accessType === 'readWrite' ? '-a' : ''} ${breakpointConditions(b.condition, b.hitCondition)} ${b.dataId}`);
				const bkpt		= record.wpt;
				this.dataBreakpoints[b.dataId] = +bkpt.number;
				return {verified: !bkpt.pending};
			}));
		});

		return {breakpoints};
	}

	protected async setInstructionBreakpointsRequest(args: DebugProtocol.SetInstructionBreakpointsArguments) {
		await this.ready;
		const breakpoints = await this.pause_while(async () => {
			//const newbps = Object.fromEntries(args.breakpoints.map(b => [adjustMemory(b.instructionReference, b.offset), b]));

			await this.clearBreakPoints('instrBreakpoints');

			return await Promise.all(args.breakpoints.map(async b => {
				const name		= adjustMemory(b.instructionReference, b.offset);
				const record	= await this.sendCommand<MI.BreakpointInsert>(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} *${name}`);
				const bkpt		= record.bkpt;
				this.instrBreakpoints[name] = +bkpt.number;
				return {verified: !bkpt.pending};
			}));
		});

		return {breakpoints};
	}

	protected async breakpointLocationsRequest(args: DebugProtocol.BreakpointLocationsArguments) {
		const record = await this.sendCommand<MI.Lines>(`-symbol-list-lines ${args.source.path}`);
		const filter: (line: MI.Line) => boolean = args.endLine
			? line => +line.line >= args.line && +line.line <= args.endLine!
			: line => +line.line === args.line;

		const breakpoints: DebugProtocol.BreakpointLocation[] = record.lines.filter(filter).map(line => ({line: +line.line}));
		return {breakpoints};
	}

	protected async gotoTargetsRequest(args: DebugProtocol.GotoTargetsArguments) {
		const record = await this.sendCommand<MI.Lines>(`-symbol-list-lines ${args.source.path}`);
		const targets: DebugProtocol.GotoTarget[] = record.lines
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
		:	this.variables[refId]		? this.fetchChildren(this.variables[refId], args.start, args.count)
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
			const record = await this.sendCommand<MI.Value>(`-var-assign ${variable.children[name].debuggerName} ${quoted(args.value)}`);
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
					if (this.buildingCommand !== undefined) {
						if (!this.python) {
							this.buildingCommand += '\n' + line;
							if (line === 'end') {
								this.buildingCommand.split('\n').forEach(i => this.sendServer(i));
								//this.sendServer(this.buildingCommand);
								//const result = (await this.sendConsoleCommand(this.buildingCommand, frameId)).join('');
								this.buildingCommand = undefined;
								return 'done';
							}
							return '';
						}
						if (line === 'exit()') {
							this.buildingCommand = undefined;
							this.python = false;
							return "Exited python interactive mode";
						}
			
						if (line.endsWith(':') || line.startsWith(' ') || line.startsWith('\t')) {
							// Continue capturing multi-line constructs
							this.buildingCommand += python_escape(line);
							return '';
						}
			
						if (this.buildingCommand) {
							this.sendCommand(`py exec("${this.buildingCommand}")`);
							this.buildingCommand = '';
						}
						if (/^\w+\s*=/.exec(line))
							line = `py exec("${python_escape(line)}")`;
						else
							line = `py print(${line})`;
			
					} else {
						line = line.trim();
						if (line.startsWith('-')) {
							const record = await this.sendCommand(`${line}`);//${this.frameCommand(args.frameId)}
							delete record.$token;
							delete record.$type;
							delete record.$class;
							this.sendEvent(new Adapter.OutputEvent({category: 'console', output: JSON.stringify(record, undefined, 2)}));
							return '';
						}
			
						if (line && line[0] !== '#') {
							const re	= /(python-interactive|pi)(?:$|\s+(.*))/;
							const m		= line.match(re);
							if (m) {
								if (!m[2]) {
									this.buildingCommand = '';
									this.python = true;
									return "Entered python interactive mode";
								}
								line = `py print(${m[2]})`;

							} else if (line.match(/^(if|while|define|((python|py)($|.*:$)))/)) {
								this.buildingCommand = line;
								return "Entered definition mode";
							}
						}
					}
					return (await this.captureConsoleCommand(line, frameId)).join('');
				};

				let result = '';
				for (const line of expression.split('\n')) {
					if (line)
						result += await evaluateLine(line, args.frameId);
				}

				return {result, variablesReference: 0};
			}

			//case 'watch':
			//case 'hover':
			default: {
				const variable = await this.getVariable(expression, args.frameId);
				return {
					result:				variable.value,
					type:				variable.type,
					variablesReference:	variable.referenceID,
					indexedVariables:	variable.numIndexed,
					memoryReference:	memoryReference(variable.value),
				};
			}
		}
	}

	protected async modulesRequest(args: DebugProtocol.ModulesArguments) {
		const record	= await this.sendCommand<MI.Modules>(`-file-list-shared-libraries`);
		const all		= record['shared-libraries'];

		let start		= args?.startModule ?? 0;
		let count		= args?.moduleCount;
		let exec		= start === 0 ? await this.getExecutable() : undefined;

		if (!exec && start > 0)
			--start;
		else if (count)
			--count;

		const modules	= await Promise.all(slice_count(all, start, count)
			.map(async (module): Promise<DebugProtocol.Module> => this.convertModule(module)));

		if (exec)
			modules.unshift(exec);

		return {
			modules,
			totalModules: all.length + 1
		};
	}

	protected async loadedSourcesRequest(_args: DebugProtocol.LoadedSourcesArguments) {
		const record	= await this.sendCommand<MI.SourceFiles>(`-file-list-exec-source-files`);
		const sources	= record.files.map((source): DebugProtocol.Source => ({
			name:	source.file,
			path:	source.fullname,
		}));
		return {sources};
	}

//Reverse Requests
	//protected async runInTerminalRequest		(_args: DebugProtocol.RunInTerminalRequestArguments)	{}
	//protected async startDebuggingRequest		(_args: DebugProtocol.StartDebuggingRequestArguments)	{}

// TBD
	//protected async cancelRequest				(_args: DebugProtocol.CancelArguments)					{}
	//protected async attachRequest				(_args: DebugProtocol.AttachRequestArguments)	        {}
	//protected async restartRequest			(_args: DebugProtocol.RestartArguments)					{}
	//protected async terminateRequest			(_args: DebugProtocol.TerminateArguments)				{}
	//protected async restartFrameRequest		(_args: DebugProtocol.RestartFrameArguments)	        {}
	//protected async terminateThreadsRequest	(_args: DebugProtocol.TerminateThreadsArguments)        {}
	//protected async stepInTargetsRequest		(_args: DebugProtocol.StepInTargetsArguments)	        {}
	//protected async locationsRequest			(_args: DebugProtocol.LocationsArguments)				{}
}
