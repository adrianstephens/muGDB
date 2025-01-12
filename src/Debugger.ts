import {spawn} from 'child_process';
import {EventEmitter} from 'events';
import {OutputRecord} from './gdb/MIParser';
import {LaunchRequestArguments, LoggingLevel, LoggingLevelValue, DebuggerException, DebuggerVariable} from './DebugSession';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as path from 'path';


export abstract class Debugger extends EventEmitter {
	protected postLoadCommands: string[] = [];
	protected terminateCommands: string[] = [];

	protected useAbsoluteFilePathsForBreakpoints = false;

	// Should we only load certain libraries?
	protected sharedLibraries: string[] = [];

	// The current thread on which the debugger is stopped on. If the debugger is not currently stopped on any thread, this value is -1.
	protected threadID = -1;
	public lastException: DebuggerException | null = null;

	private toServer?: {write(command: string): void};

	// Is the debugger ready to start accepting commands?
	private ready?: () => void;
	protected onDebuggerReady = new Promise<void>(resolve => { this.ready = resolve; });
	protected startupPromises: Promise<void>[] = [];

	protected inferiorRunning = false;

	constructor(protected log: (level: LoggingLevelValue, line: string) => void) {
		super();
	}

	protected send(command: string) {
		this.log(LoggingLevel.verbose, command);
		if (this.toServer)
			this.toServer.write(command + '\n');
	}

	public async spawn(args: LaunchRequestArguments): Promise<boolean> {
		this.useAbsoluteFilePathsForBreakpoints = args.useAbsoluteFilePaths || false;
		this.sharedLibraries = args.sharedLibraries || [];

		this.postLoadCommands = args.postLoadCmds || [];
		this.terminateCommands = args.terminateCmds || [];

		const args2 = this.createDebuggerLaunchCommand(args);

		const gdb = spawn(args2[0], args2.slice(1), {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: args.cwd,
			env: args.env
		});

		// Handle debugger input
		this.toServer = gdb.stdin;

		// Handle debugger output
		let outputBuffer = '';
		gdb.stdout.on('data', data => {
			outputBuffer += data.toString('utf8');
			const lines = outputBuffer.split('\n') as string[];
			outputBuffer = lines.pop()!;
			lines.forEach(line => {
				this.log(LoggingLevel.verbose, line);
				this.handleOutput(line)
			});
		});

		// Handle debugger stderr
		gdb.stderr.on('data', data => console.log(data.toString()));

		if (args.startupCmds?.length)
			await Promise.all(args.startupCmds.map(cmd => this.sendCommand(cmd)));

		this.ready!();
		await Promise.all(this.startupPromises);
		return true;
	}

	public abstract clearBreakpoints(fileName: string): Promise<void>;
	public abstract createVariable(name: string, frameID?: number): Promise<DebuggerVariable>;
	public abstract continue(threadID?: number): Promise<OutputRecord>;
	public abstract evaluateExpression(expr: string, frameID?: number): Promise<OutputRecord>;
	public abstract getStackTrace(threadID: number): Promise<DebugProtocol.StackFrame[]>;
	public abstract getCommandCompletions(command: string): Promise<DebugProtocol.CompletionItem[]>;
	public abstract getDisassembly(memoryAddress: string, count: number): Promise<DebugProtocol.DisassembledInstruction[]>;
	public abstract getMemory(memoryAddress: string, count: number): Promise<[number, Buffer]|undefined>;
	public abstract getThreads(): Promise<DebugProtocol.Thread[]>;
	public abstract getVariable(name: string): DebuggerVariable | undefined;
	public abstract getVariables(referenceID: number): Promise<DebuggerVariable[]>;
	public abstract goto(file: string, line: number): Promise<void>;
	public abstract next(threadID: number, granularity: string): Promise<OutputRecord>;
	public abstract pause(threadID?: number, ignorePause?: boolean): Promise<boolean>;
	public abstract sendCommand(command: string): Promise<OutputRecord>;
	public abstract sendUserCommand(command: string, frameID?: number): Promise<OutputRecord>;
	public abstract setBreakpoints(fileName: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]>;
	public abstract setExceptionBreakpoints(filter: string[]): Promise<void>;
	public abstract setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]>;
	public abstract setVariable(referenceID: number, args: DebugProtocol.SetVariableArguments): Promise<OutputRecord | undefined>;
	public abstract stepIn(threadID: number): Promise<OutputRecord>;
	public abstract stepOut(threadID: number): Promise<OutputRecord>;
	public abstract stepBack(threadID: number): Promise<OutputRecord>;
	public abstract terminate(): Promise<void>;
	public abstract configurationDone(): Promise<void>;
	public abstract reverseContinue(threadID: number): Promise<OutputRecord>;

	protected abstract createDebuggerLaunchCommand(args: LaunchRequestArguments): string[];
	protected abstract handleOutput(line: string): void;

	public setInferiorLaunched(hasLaunched: boolean): void {
		this.inferiorRunning = hasLaunched;
	}

	protected isStopped(threadID?: number): boolean {
		return this.threadID !== -1 && (threadID === undefined || this.threadID === threadID);
	}

	protected getNormalizedFileName(fileName: string): string {
		return this.useAbsoluteFilePathsForBreakpoints ? fileName : path.basename(fileName);
	}

}

