import * as path from 'path';
import {spawn} from 'child_process';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as Adapter from '../DebugAdapter';
import * as MI from './MIParser';

import {
	DebugSession,
	DebuggerException,
	LaunchRequestArguments,
	adjustMemory,
	memoryReference,
	SCOPE_LOCAL,
	SCOPE_REGISTERS,
} from '../DebugSession';

interface Register {
	name:		string,
	rel?:		number,
	offset?: number,
	size?:	 number,
	type?:	 string,
	groups?: string[]
}

interface RegisterGroup {
	includes: bigint;
	children: Record<string, RegisterGroup>;
	offset?:	number;
}

class GDBException extends DebuggerException {
	location: string;

	constructor(record: MI.OutputRecord) {
		super(`${record.results['signal-meaning']} (${record.results['signal-name']})`, '');
		const frame = record.results['frame'];
		this.location = `${frame.addr} in ${frame.func} at ${frame.file}:${frame.line}`;
	}
}

interface DebuggerVariable {
	name:							string;
	debuggerName: 		string;	// The unique "name" assigned by the underlying MI debugger need not be identical to the actual source location name
	numberOfChildren: number;
	referenceID: 			number;
	value: 						string;
	type: 						string;
}


class Deferred {
	private promise = Promise.resolve();
	private resolver?: () => void;

	constructor(ready: boolean) {
		if (!ready)
			this.reset();
	}
	resolve() {
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

function quoted(str: string): string {
	return '"' + str.replace(/"/g, '\\"') + '"';
}

function breakpointConditions(condition?: string, hitCondition?: string) {
	return `${condition ? `-c ${quoted(condition)}` : ''} ${hitCondition ? `-i ${hitCondition}` : ''}`;
}
function granularity(granularity?: string) {
	return granularity === 'instruction' ? '-instruction' : '';
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

const outputs: Record<MI.StreamRecordType, string> = {
	[MI.StreamRecordType.CONSOLE]:	'console',
	[MI.StreamRecordType.TARGET]:		'stdout',
	[MI.StreamRecordType.LOG]:			'log',
}

export class GDB extends DebugSession {
	// Default path to MI debugger. If none is specified in the launch config we will fallback to this path
	protected debuggerPath = 'gdb';

	// This instance will handle all MI output parsing
	private parser = new MI.MIParser();

	// Used to sync MI inputs and outputs. Value increases by 1 with each command issued
	private token = 0;

	// Libraries for which debugger has loaded debug symbols for
	private loadedLibraries: Record<string, boolean> = {};

	// Callbacks to execute when a command identified by "token" is resolved by the debugger
	private handlers: {[token: number]: (record: MI.OutputRecord) => void} = [];

	private breakpoints:					Record<string, number[]> = {};
	private logBreakpoints:			 	Record<number, string> = {};
	private functionBreakpoints:	Record<string, number> = {};
	private exceptionBreakpoints: Record<string, number> = {};
	private dataBreakpoints: 			Record<string, number> = {};
	private instsBreakpoints: 		Record<string, number> = {};

	// Mapping of symbolic variable names to GDB variable references
	private variables: DebuggerVariable[] = [];

	// Mapping of register numbers to their names
	private registers: Register[] = [];
	private registerGroups: RegisterGroup[] = [];

	private ignorePause	= false;
	private stopped 		= new Deferred(true);
	private ready 			= new Deferred(false);
	private startupPromises: Promise<void>[] = [];

	private capture?: 	string[];

	private frameCommand(frameId?: number) {
		return frameId ? `--frame ${frameId - this.threadId} --thread ${this.threadId}` : ''
	}

	public sendCommand(command: string): Promise<MI.OutputRecord> {
		command = `${++this.token + command}`;

		return new Promise(resolve => {
			this.sendServer(command);
			this.handlers[this.token] = (record: MI.OutputRecord) => resolve(record);
		});
	}

	public async sendUserCommand(command: string, frameId?: number): Promise<void> {
		const interpreter = command.startsWith('-') ? 'mi' : 'console';

		const cmd = `-interpreter-exec ${this.frameCommand(frameId)} ${interpreter} ${quoted(command)}`;

		const record = await this.sendCommand(cmd);
		// If an error has resulted, also send an error event to show it to the user
		if (record.isError)
			this.error(record.results['msg'].replace(/\\/g, ''));
	}

	protected async sendCommands(commands: string[]): Promise<void> {
		await Promise.all(commands.map(cmd => this.sendCommand(cmd)));
	}


	private gotStop(reason: string, allThreadsStopped?: boolean): void {
		this.sendEvent(new Adapter.StoppedEvent({reason, threadId: this.threadId, allThreadsStopped}))
		this.stopped.resolve();
	}

	protected recvServer(line: string): void {
		try {
			const record = this.parser.parse(line);
			if (!record)
				return;

			if (record.isStreamRecord()) {
				if (this.capture && record.type === MI.StreamRecordType.CONSOLE) {
					this.capture.push(record.cstring);
				} else {
					this.sendEvent(new Adapter.OutputEvent({category: outputs[record.type], output: record.cstring}))
				}

			} else if (record.isAsyncRecord()) {
				switch (record.type) {
					case MI.AsyncRecordType.RESULT:
						if (isNaN(record.token)) {
							this.sendEvent(new Adapter.OutputEvent({category: 'console', output: line}))

						} else {
							const handler = this.handlers[record.token];
							if (handler) {
								handler(record);
								delete this.handlers[record.token];
							} else {
								// There could be instances where we should fire DAP events even if the request did not originally contain
								// a handler. For example, up/down should correctly move the active stack frame in VSCode
							}
						}
						break;

					case MI.AsyncRecordType.EXEC:
						switch (record.klass) {
							case 'stopped': {
								const reason			= record.results['reason'];
								const allStopped	= record.results['stopped-threads'] === 'all';
								this.threadId			= parseInt(record.results['thread-id']);

								if (!reason) {
									if (this.inferiorRunning)
										this.sendEvent(new Adapter.StoppedEvent({reason: 'breakpoint', threadId: this.threadId}))
									return;
								}

								switch (reason) {
									case 'breakpoint-hit': {
										const bkpt = record.results['bkptno'];
										const msg = this.logBreakpoints[bkpt];

										if (msg) {
											this.printLogPoint(msg).then(msgFormtted => {
												this.sendEvent(new Adapter.OutputEvent({category: 'stdout', output: msgFormtted}))
											});
										}
										this.gotStop('breakpoint', allStopped);
										break;
									}

									case 'end-stepping-range':
										this.gotStop('step', allStopped);
										break;

									case 'function-finished':
										this.gotStop('step-out', allStopped);
										break;

									case 'exited-normally':
										// The inferior has finished execution. Take down the debugger and inform the debug session that there is nothing else to debug.
										this.sendCommand('quit');
										this.sendEvent(new Adapter.Event('terminated'))
										break;

									case 'signal-received':
										if (!this.ignorePause) {
											if (record.results['signal-meaning'] === 'Interrupt') {
												this.gotStop('pause', allStopped);
											} else {
												this.lastException = new GDBException(record);
												this.gotStop('exception', allStopped);
											}
										}
										this.stopped.resolve();
										break;

									case 'solib-event':
										// This event will only be hit if the user has explicitly specified a set of shared libraries
										// for deferred symbol loading so we need not check for the presence of such setting
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
								const threadId = record.results['thread-id'];
								if (threadId === 'all' || this.threadId === threadId) {
									this.sendEvent(new Adapter.ContinuedEvent({threadId: this.threadId, allThreadsContinued: threadId === 'all'}))
									this.threadId = -1;
									// When the inferior resumes execution, remove all tracked variables which were used to service variable reference IDs
									this.clearVariables();
									this.stopped.reset()
								}
								break;
							}
						}
						break;

					case MI.AsyncRecordType.NOTIFY:
						switch (record.klass) {
							case 'thread-created':
								this.sendEvent(new Adapter.ThreadEvent({reason: 'started', threadId: record.results['id']}));
								break;

							case 'library-loaded': {
								// If deferred symbol loading is enabled, check that the shared library loaded is in the user specified list
								const libLoaded = path.basename(record.results['id']);
								if (this.sharedLibraries.includes(libLoaded))
									this.loadedLibraries[libLoaded] = true;
								break;
							}
							default: {
								console.log('Unhandled notify', record);
								break;
							}
						}
						break;

					case MI.AsyncRecordType.STATUS:
						// TODO
						break;
				}
			}

		} catch (error: any) {
			this.error(error);
			this.sendEvent(new Adapter.Event('terminated'));
		}
	}

	private getNormalizedVariableID(id: number): number {
		return id < SCOPE_LOCAL ? id : id - SCOPE_LOCAL;
	}

	private getVariable(expression: string): DebuggerVariable | undefined {
		for (const index in this.variables) {
			if (this.variables[index].name === expression)
					return this.variables[index];
		}
	}

	private async clearVariables(): Promise<void> {
		await Promise.all(Object.values(this.variables).map(variable => this.sendCommand(`-var-delete ${variable.debuggerName}`)));
		this.variables = [];
	}

	private async createVariable(expression: string, frameId?: number): Promise<DebuggerVariable | undefined> {
		const record = await this.sendCommand(`-var-create ${this.frameCommand(frameId)} - * ${quoted(expression)}`);
		if (record.isError)
			return;

		const v = record.results as MI.CreateVariable;
		const numberOfChildren	= +v.numchild || +v.dynamic || +v.has_more;
		const refId							= this.variables.length + 1;
		const variable: DebuggerVariable = {
			name:							expression,
			debuggerName:			v.name,
			numberOfChildren,
			referenceID:			numberOfChildren ? refId : 0,
			value:						v.value,
			type: 						v.type,
		};

		this.variables[refId] = variable;
		return variable;
	}

	private async getVariableChildren(variableName: string) {
		const record = await this.sendCommand(`-var-list-children --simple-values "${variableName}"`);
		let children: DebuggerVariable[] = [];

		// Safety check
		if (parseInt(record.results.numchild)) {
			const pending: Promise<DebuggerVariable[]>[] = [];

			(record.results.children as [string, MI.ChildVariable][]).forEach(([_, child]) => {
				if (!child.type && !child.value) {
					// this is a pseudo child on an aggregate type such as private, public, protected, etc
					// traverse into child and annotate its consituents with such attribute for special treating by the front-end
					// Note we could have mulitple such pseudo-levels at a given level
					pending.push(this.getVariableChildren(child.name));

				} else {
					children.push({
						name:							child.exp,
						debuggerName:			child.name,
						numberOfChildren: +child.numchild || (+child.dynamic && child.displayhint !== 'string' ? 1 : 0), // TODO: hacky -- revisit this
						referenceID:			-1,
						value:						child.value || '',
						type:							child.type,
					});
				}
			});
			(await Promise.all(pending)).forEach(variables => { children = [...children, ...variables];});
		}
		return children;
	}

	private async getRegisterInfo() {
		const record 		= await this.sendCommand('-data-list-register-names');
		this.registers	= record.results['register-names'].map((name: string) => ({name}));

		this.capture 		= [];
		await this.sendCommand('-interpreter-exec console "maintenance print register-groups"');

		const re = /^\s*(\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\w+,]+)/;
		this.capture.map(line => re.exec(line)).filter(match => match).forEach(match => {
			this.registers[parseInt(match![2])] = {
				name: match![1],
				rel:		parseInt(match![3]),
				offset: parseInt(match![4]),
				size:	 parseInt(match![5]),
				type:	 match![6],
				groups: match![7].split(',')
			};
		});
		this.capture = undefined;

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

		// Build hierarchy by finding subsets
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

		// remove children's registers
		for (const i in groups) {
			const g = groups[i];
			if (g.offset === undefined) {
				g.offset = this.registerGroups.length;
				this.registerGroups.push(g);
			}

			for (const c of Object.values(g.children))
				g.includes &= ~c.includes;
		}
	}

	private async continue(threadID?: number): Promise<void> {
		this.ignorePause = false;
		if (threadID)
			await this.sendCommand(`-exec-continue --thread ${threadID}`);
		else
			await this.sendCommand('-exec-continue');
	}

	private async pause(): Promise<boolean> {
		if (this.threadId !== -1)
			return true;

		this.ignorePause = true;

		await this.sendCommand('-exec-interrupt');
		await this.stopped;
		return false;
	}

	private async printLogPoint(msg: string): Promise<string> {
		const vars = msg.match(/{.*?}/g);

		if (vars) {
			await Promise.all(vars.map(async v => {
				const varName = v.replace('{', '').replace('}', '');
				const vObj = await this.sendCommand(`-var-create - * "${varName}"`);
				const vRes = await this.sendCommand(`-var-evaluate-expression ${vObj.results['name']}`);
				msg = msg.replace(v, vRes.results['value']);
			}));
		}
		return msg;
	}
	private async clearBreakPoints(breakpoints: Record<string, number>) {
		await Promise.all(Object.values(breakpoints).map((num: number) => this.sendCommand(`-break-delete ${num}`)));
		breakpoints = {};
	}

	//-----------------------------------
	// Adapter handlers
	//-----------------------------------

	protected async launchRequest(args: LaunchRequestArguments) {
		super.launchRequest(args);

		const args2 = [...args.debuggerArgs || [], '--interpreter=mi', '--tty=`tty`', '-q'];

		const gdb = spawn(args.debugger || 'gdb', args2, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: args.cwd,
			env: args.env
		});

		this.setCommunication(gdb);

		if (args.startupCmds?.length)
			await Promise.all(args.startupCmds.map(cmd => this.sendCommand(cmd)));

		this.ready.resolve();
		await Promise.all(this.startupPromises);
	}

	protected async configurationDoneRequest(_args: DebugProtocol.ConfigurationDoneArguments) {
		// registers
		this.getRegisterInfo();

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
			const result: MI.OutputRecord = await this.sendCommand('-gdb-show auto-solib-add');
			if (result.results['value'] !== 'off')
				postLoadCommands = [
					'sharedlibrary',
					...postLoadCommands
				];
			}

		await Promise.all(postLoadCommands.map(cmd => this.sendCommand(cmd)));
		this.inferiorRunning = true;
	}

	protected async disconnectRequest(_args: DebugProtocol.DisconnectArguments) {
		const terminateCommands = [...this.terminateCommands, '-gdb-exit'];
		await Promise.all(terminateCommands.map(cmd => this.sendCommand(cmd)));
	}

	protected async stackTraceRequest(args: DebugProtocol.StackTraceArguments) {
		const record = await this.sendCommand(`-stack-list-frames --thread ${args.threadId}`);

		const stack = (record.results['stack'] as [string, MI.Frame][]).map(([_, frame]): DebugProtocol.StackFrame =>	{
			return {
				id:		 args.threadId + +frame.level,
				name:	 frame.func,
				source: {
					name: frame.file ? path.basename(frame.file) : '??',
					path: frame.fullname
				},
				line:	 +frame.line,
				column: 0,
				instructionPointerReference: frame.addr
			};
		});

		return {
			stackFrames: stack,
			totalFrames: stack.length - 1,
		};
	}

	protected async completionsRequest(args: DebugProtocol.CompletionsArguments) {
		const record = await this.sendCommand(`-complete "${args.text}"`);
		return {targets: record.results['matches'].map((match: string) => ({label: match, start: 0}))};
	}

	protected async disassembleRequest(args: DebugProtocol.DisassembleArguments) {
		const memoryAddress = adjustMemory(args.memoryReference, args.offset);
		const record = await this.sendCommand(`-data-disassemble -s ${memoryAddress} -e ${adjustMemory(memoryAddress, args.instructionCount)} -- 0`);
		const insts = record.results['asm_insns'] as any[];

		const instructions = insts.map(inst => ({
			address: inst.address,
			instruction: inst.inst,
			...(!+inst.offset && {symbol: inst['func-name']})
		}));
		return {instructions};
	}

	protected async readMemoryRequest(args: DebugProtocol.ReadMemoryArguments) {
		const address = adjustMemory(args.memoryReference, args.offset);
		const record = await this.sendCommand(`-data-read-memory-bytes ${address} ${args.count}`);
		const memory = record.results['memory'] as MI.Memory[];

		const data = memory && memory.length > 0 ? Buffer.from(memory[0].contents, 'hex').toString('base64'): '';
		return {
			address,
			data,
			unreadableBytes: data ? +address - +memory[0].begin : args.count
		};
	}

	protected async writeMemoryRequest(args: DebugProtocol.WriteMemoryArguments) {
		const address = adjustMemory(args.memoryReference, args.offset);
		const data = Buffer.from(args.data, 'base64').toString('hex');
		await this.sendCommand(`-data-write-memory-bytes ${address} ${data}`);
	}

	protected async threadsRequest() {
		const record = await this.sendCommand('-thread-info');
		const threads = record.results['threads'].map((thread: any) => ({id: parseInt(thread.id), name: thread.name}));
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
			await this.sendCommand(`-exec-next${granularity(args.granularity)} --reverse --thread ${args.threadId}`);
	}

	protected async continueRequest(args: DebugProtocol.ContinueArguments) {
		await this.continue(args.threadId);
		return {allThreadsContinued: true};
	}

	protected async reverseContinueRequest(_args: DebugProtocol.ReverseContinueArguments) {
		await this.sendCommand('rc');
	}

	protected async pauseRequest(args: DebugProtocol.PauseArguments) {
		await this.sendCommand(`-exec-interrupt ${args.threadId || ''}`);
	}

	protected async setBreakpointsRequest(args: DebugProtocol.SetBreakpointsArguments) {
		const fileName 		= args.source.path || '';
		const breakpoints	= args.breakpoints || [];
		const normalizedFileName = this.getNormalizedFileName(fileName);

		const promise = this.ready.then(async () => {
			// There are instances where breakpoints won't properly bind to source locations despite enabling async mode on GDB.
			// To ensure we always bind to source, explicitly pause the debugger, but do not react to the signal from the UI side so as to not get the UI in an odd state
			const wasPaused = await this.pause();

			if (this.breakpoints[fileName]) {
				await Promise.all(this.breakpoints[fileName].map(breakpoint => {
					if (this.logBreakpoints[breakpoint])
						delete this.logBreakpoints[breakpoint];
					return this.sendCommand(`-break-delete ${breakpoint}`);
				}));
				delete this.breakpoints.fileName;
			}

			const confirmed:	DebugProtocol.Breakpoint[] = [];
			const ids: 				number[] = [];

			try {
				await Promise.all(breakpoints.map(async b => {
					const record	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} -f ${normalizedFileName}:${b.line}`);
					const bkpt		= record.results['bkpt'];
					if (bkpt) {
						confirmed.push({verified: !bkpt.pending, line:bkpt.line});
						ids.push(parseInt(bkpt.number));

						if (b.logMessage)
							this.logBreakpoints[bkpt.number] = b.logMessage;

					}
				}));
			} catch (e) {
				console.error(e);
			}

			// Only return breakpoints GDB has actually bound to a source; others will be marked verified as the debugger binds them later on
			this.breakpoints[fileName] = ids;

			if (!wasPaused && this.inferiorRunning)
				this.continue();

			return {breakpoints: confirmed};
		});

		this.startupPromises.push(promise.then(() => {}));
		return promise;
	}

	protected async setExceptionBreakpointsRequest(args: DebugProtocol.SetExceptionBreakpointsArguments) {
		await this.clearBreakPoints(this.exceptionBreakpoints);

		await Promise.all(args.filters.map(async type => {
			const result = await this.sendCommand(`-catch-${type}`);
			this.exceptionBreakpoints[type] = result.results['bkpt'].number;
		}));
	}

	protected async setFunctionBreakpointsRequest(args: DebugProtocol.SetFunctionBreakpointsArguments) {
		await this.clearBreakPoints(this.functionBreakpoints);

		const breakpoints = await Promise.all(args.breakpoints.map(async b => {
			const result	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} ${b.name}`);
			const bkpt		= result.results['bkpt'];
			this.functionBreakpoints[b.name] = bkpt.number;
			return {verified:!bkpt.pending, line: bkpt.line};
		}));
		return {breakpoints};
	}

	protected async dataBreakpointInfoRequest(args: DebugProtocol.DataBreakpointInfoArguments) {
		let dataId = args.name;

		if (args.variablesReference) {
			const variable = this.variables[this.getNormalizedVariableID(args.variablesReference)];
			if (variable?.debuggerName) {
				const record = await this.sendCommand(`-var-info-path-expression "${variable.debuggerName}.${args.name}"`);
				dataId = record.results['path_expr'] ?? '';
			}
		}

		return {
			dataId,
			description: args.name,
			accessTypes: ['read', 'write', 'readWrite'] as DebugProtocol.DataBreakpointAccessType[],
			canPersist: false
		};
	}

	protected async setDataBreakpointsRequest(args: DebugProtocol.SetDataBreakpointsArguments) {
		await this.clearBreakPoints(this.dataBreakpoints);

		const breakpoints = await Promise.all(args.breakpoints.map(async b => {
			const result	= await this.sendCommand(`-break-watch ${b.accessType === 'read' ? '-r' : b.accessType === 'readWrite' ? '-a' : ''} ${breakpointConditions(b.condition, b.hitCondition)} ${b.dataId}`);
			const bkpt		= result.results.wpt;
			this.dataBreakpoints[b.dataId] = bkpt.number;
			return {verified:!bkpt.pending};
		}));
		return {breakpoints};
	}

	protected async setInstructionBreakpointsRequest(args: DebugProtocol.SetInstructionBreakpointsArguments)	{
		await this.clearBreakPoints(this.instsBreakpoints);
		const breakpoints = await Promise.all(args.breakpoints.map(async b => {
			const	name		= adjustMemory(b.instructionReference, b.offset);
			const result	= await this.sendCommand(`-break-insert ${breakpointConditions(b.condition, b.hitCondition)} *${name}`);
			const bkpt		= result.results['bkpt'];
			this.instsBreakpoints[name] = bkpt.number;
			return {verified:!bkpt.pending, line: bkpt.line};
		}));
		return {breakpoints};
	}


	protected async breakpointLocationsRequest(args: DebugProtocol.BreakpointLocationsArguments) {
    const record = await this.sendCommand(`-symbol-list-lines ${args.source.path}`);

		const filter = args.endLine
			? (line: MI.Line) => +line.line >= args.line && +line.line <= args.endLine!
			: (line: MI.Line) => +line.line === args.line;

    if (record.results.lines) {
			const breakpoints: DebugProtocol.BreakpointLocation[] = (record.results.lines as MI.Line[])
				.filter(filter)
				.map(line => ({
					line:			+line.line,
				}));
				return { breakpoints };
		}
	}

	protected async gotoTargetsRequest(args: DebugProtocol.GotoTargetsArguments) {
    const record = await this.sendCommand(`-symbol-list-lines ${args.source.path}`);

    if (record.results.lines) {
			const targets: DebugProtocol.GotoTarget[] = (record.results.lines as MI.Line[])
				.filter(line => +line.line === args.line)
				.sort((a, b) => +a.pc - +b.pc)
				.filter((line, index, lines) => index === 0 || line.pc !== lines[index - 1].pc)
				.map(line => ({
					id:			+line.pc,  // The address we'll jump to
					label:	args.source?.name ?? '?',
					line:		+line.line,
					instructionPointerReference: line.pc
				}));
			return { targets };
		}

		return { targets: [] };
	}

	protected async gotoRequest(args: DebugProtocol.GotoArguments) {
		await this.sendCommand(`-data-evaluate-expression "$pc=0x${args.targetId.toString(16)}"`);
		setTimeout(() => this.gotStop('goto'), 0);
	}

	protected async variablesRequest(args: DebugProtocol.VariablesArguments) {
		let children: DebuggerVariable[] = [];

		if (args.variablesReference < SCOPE_LOCAL) {
			// Fetch children variables for an existing variable
			const variable = this.variables[args.variablesReference];
			children = (variable && await this.getVariableChildren(variable.debuggerName)) || [];

			children.forEach(child => {
				child.referenceID = this.variables.length;
				this.variables.push(child);
			});

		} else if (args.variablesReference < SCOPE_REGISTERS) {
			// Fetch root level locals
			await this.clearVariables();
			const frameId = args.variablesReference - SCOPE_LOCAL;
			const record	= await this.sendCommand(`-stack-list-variables ${this.frameCommand(frameId)} --no-frame-filters --simple-values`);

			await Promise.all(record.results['variables'].map((variable: any) => this.createVariable(variable.name, frameId)));
			children = this.variables;

		} else {
			// Fetch registers
			const group = this.registerGroups[args.variablesReference - SCOPE_REGISTERS];
			const record = await this.sendCommand(`-data-list-register-values N ${bitlist(group.includes).map(i => i.toString()).join(' ')}`);

			children = [
				...Object.keys(group.children).map(i => ({
					name: 				i,
					debuggerName: i,
					value: '',
					type: '',
					numberOfChildren: 1,
					referenceID: SCOPE_REGISTERS + group.children[i].offset!,
				})),
				...record.results['register-values']
				//.filter((reg: any) => group.includes & (1n << BigInt(reg.number)))
				.map((reg: any) => ({
					name: this.registers[reg.number].name,
					value: reg.value
				}))
			];
		}

		const	variables	= children.map((v): DebugProtocol.Variable => ({
				name: 	v.name,
				value: 	v.value,
				type: 	v.type,
				variablesReference:	v.numberOfChildren ? v.referenceID : 0,
				memoryReference:		memoryReference(v.value)
		}));
		return {variables};
	}

	protected async setVariableRequest(args: DebugProtocol.SetVariableArguments) {
		if (args.variablesReference >= SCOPE_REGISTERS) {
			const record = await this.sendCommand(`-data-evaluate-expression "$${args.name}=${args.value}"`);
			return {
				value: record.results.value,
			};
		}
		const variable = this.variables[this.getNormalizedVariableID(args.variablesReference)];

		// This should always hit in the map, but if it doesn't, do not allow the updating of this variable
		if (variable) {
			let accessName = variable.debuggerName;
			if (args.name !== variable.name)
				accessName = `${accessName}.${args.name}`;
			const record = await this.sendCommand(`-var-assign ${accessName} ${args.value}`);
			return {
				value: record.results.value,
			};
		}
	}

	protected async setExpressionRequest(args: DebugProtocol.SetExpressionArguments) {
		const record	= await this.sendCommand(`-data-evaluate-expression ${this.frameCommand(args.frameId)} "${args.expression}=${args.value}"`);
		const value = record.results['value'];
		return {
			value,
			memoryReference:	memoryReference(value)
		};
	}

	protected async evaluateRequest(args: DebugProtocol.EvaluateArguments) {
		switch (args.context) {
			case 'repl':
				this.sendUserCommand(args.expression, args.frameId);
				break;

			case 'watch':
			case 'hover': {
				// If variable is already being tracked, reuse "cached" result
				const variable = this.getVariable(args.expression) || await this.createVariable(args.expression, args.frameId)

				if (!variable)
					throw {message: `Variable '${args.expression}' not found`};

				return {
					result:							variable.value,
					variablesReference:	variable.referenceID,
					memoryReference:		memoryReference(variable.value),
				};
			}
		}
	}

	protected async modulesRequest(args: DebugProtocol.ModulesArguments) {
		const record = await this.sendCommand(`-file-list-shared-libraries`);
    if (record.results['shared-libraries']) {
			const modules = ((record.results['shared-libraries']) as MI.Module[]).map((module: MI.Module): DebugProtocol.Module => ({
				id:			module.id,
				name:		module['host-name'],
				path:		module['target-name'],
				symbolStatus:		+module['symbols-loaded'] ? 'loaded' : 'not loaded',
				addressRange:		module.ranges[0].from
			}));
			const start = args.startModule ?? 0;
			return {
				modules: args.moduleCount ? modules.slice(start, start + args.moduleCount) : modules.slice(start),
				totalModules:	modules.length
			};
		}
	}

// TBD
	//protected async cancelRequest	                    (_args: DebugProtocol.CancelArguments)	                  {}
	//protected async runInTerminalRequest	            (_args: DebugProtocol.RunInTerminalRequestArguments)	    {}
	//protected async startDebuggingRequest	            (_args: DebugProtocol.StartDebuggingRequestArguments)	    {}
	//protected async attachRequest	                    (_args: DebugProtocol.AttachRequestArguments)	            {}
	//protected async restartRequest	                  (_args: DebugProtocol.RestartArguments)	                  {}
	//protected async terminateRequest	                (_args: DebugProtocol.TerminateArguments)	                {}
	//protected async restartFrameRequest	              (_args: DebugProtocol.RestartFrameArguments)	            {}
	//protected async sourceRequest	                    (_args: DebugProtocol.SourceArguments)	                  {}
	//protected async terminateThreadsRequest	          (_args: DebugProtocol.TerminateThreadsArguments)	        {}
	//protected async loadedSourcesRequest	            (_args: DebugProtocol.LoadedSourcesArguments)	            {}
	//protected async stepInTargetsRequest	            (_args: DebugProtocol.StepInTargetsArguments)	            {}
	//protected async locationsRequest	                (_args: DebugProtocol.LocationsArguments)	                {}
}
