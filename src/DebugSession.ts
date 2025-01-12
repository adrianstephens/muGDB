import * as vscode from 'vscode';
import {ChildProcessWithoutNullStreams} from 'child_process';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as Adapter from './DebugAdapter';
import * as path from 'path';

export const SCOPE_LOCAL = 100000;
export const SCOPE_REGISTERS = 200000;

export class DebuggerException {
	constructor(public name: string, public description: string) {}
}

export const LoggingLevel = {
	off: 0,
	basic: 1,
	verbose: 2,
} as const;

export type LoggingLevelKeys = keyof typeof LoggingLevel;
export type LoggingLevelValue = typeof LoggingLevel[LoggingLevelKeys];

export type LaunchRequestArguments = DebugProtocol.LaunchRequestArguments & {
	debugger:							string;
	debuggerArgs?:				string[];
	cwd?:									string;
	env?:									{ [key: string]: string };
	capabilities?:				DebugProtocol.Capabilities;
	startupCmds?:					string[];
	postLoadCmds?:				string[];
	terminateCmds?:				string[];
	logging?:							LoggingLevelKeys;
	useAbsoluteFilePaths?: boolean;
	sharedLibraries?:			string[];
	externalConsole?:			boolean;
}

export function adjustMemory(memoryReference: string, offset?: number): string {
	return offset ? '0x' + (+memoryReference + offset).toString(16) : memoryReference;
}

export function memoryReference(value: string): string | undefined {
	const match = /^(0x[0-9a-fA-F]+)/.exec(value);
	if (match)
		return match[1];
}



// This is the main class which implements the debug adapter protocol. It will
// instantiate a separate GDB object which handles spawning and interacting with
// the GDB process (i.e. parsing MI output). The session handles requests and
// responses with the IDE
export abstract class DebugSession extends Adapter.DebugAdapter {
	private logging: LoggingLevelValue;

	private capabilities: DebugProtocol.Capabilities = {
		supportsConfigurationDoneRequest:	      true,
		supportsFunctionBreakpoints:	          true,
		supportsConditionalBreakpoints:	        true,
		supportsHitConditionalBreakpoints:	    true,
		supportsEvaluateForHovers:	            true,
		exceptionBreakpointFilters: [
			{filter: 'throw', label: 'Thrown Exceptions'},
			{filter: 'catch', label: 'Caught Exceptions'},
		],
		//supportsStepBack:	                      true,
		supportsSetVariable:	                  true,
		//supportsRestartFrame:	                  true,
		supportsGotoTargetsRequest:	            true,
		//supportsStepInTargetsRequest:	          true,
		supportsCompletionsRequest:	            true,
		//completionTriggerCharacters:           	[],
		supportsModulesRequest:	                true,
		//additionalModuleColumns:                [],
		//supportedChecksumAlgorithms:            [],
		//supportsRestartRequest:	                true,
		//supportsExceptionOptions:	              true,
		//supportsValueFormattingOptions:	        true,
		supportsExceptionInfoRequest:	          true,
		//supportTerminateDebuggee:	              true,
		//supportSuspendDebuggee:	                true,
		//supportsDelayedStackTraceLoading:	      true,
		//supportsLoadedSourcesRequest:	          true,
		supportsLogPoints:	                    true,
		//supportsTerminateThreadsRequest:	      true,
		supportsSetExpression:	                true,
		//supportsTerminateRequest:	              true,
		supportsDataBreakpoints:	              true,
		supportsReadMemoryRequest:	            true,
		supportsWriteMemoryRequest:	            true,
		supportsDisassembleRequest:	            true,
		//supportsCancelRequest:	                true,
		supportsBreakpointLocationsRequest:	    true,
		//supportsClipboardContext:	              true,
		supportsSteppingGranularity:	          true,
		supportsInstructionBreakpoints:	        true,
		//supportsExceptionFilterOptions:	        true,
		//supportsSingleThreadExecutionRequests:	true,
		//supportsDataBreakpointBytes:	          true,
		//breakpointModes:                        [],
		//supportsANSIStyling:	                  true,
	};
	protected postLoadCommands: string[] = [];
	protected terminateCommands: string[] = [];
	protected useAbsoluteFilePathsForBreakpoints = false;
	protected sharedLibraries: string[] = [];
	protected threadId = -1;
	protected	lastException: DebuggerException | null = null;
	private 	toServer?: {write(command: string): void};
	protected inferiorRunning = false;

	constructor(private readonly outputChannel: vscode.OutputChannel, _configuration: vscode.DebugConfiguration) {
		super();
		const configuration = _configuration as unknown as LaunchRequestArguments;
		this.capabilities	= {...this.capabilities, ...configuration.capabilities};
		this.logging			= configuration.logging ? LoggingLevel[configuration.logging] : LoggingLevel.off;
	}

	protected abstract recvServer(line: string): void;

	protected getNormalizedFileName(fileName: string): string {
		return this.useAbsoluteFilePathsForBreakpoints ? fileName : path.basename(fileName);
	}

	protected sendServer(command: string) {
		this.log(LoggingLevel.verbose, command);
		if (this.toServer)
			this.toServer.write(command + '\n');
	}

	protected setCommunication(process: ChildProcessWithoutNullStreams) {
		this.toServer = process.stdin;

		let outputBuffer = '';
		process.stdout.on('data', data => {
			outputBuffer += data.toString('utf8');
			const lines = outputBuffer.split('\n') as string[];
			outputBuffer = lines.pop()!;
			lines.forEach(line => {
				this.log(LoggingLevel.verbose, line);
				this.recvServer(line)
			});
		});

		process.stderr.on('data', data => console.log(data.toString()));
	}

  public log(level: LoggingLevelValue, text: string): void {
		if (level >= this.logging)
			this.outputChannel.appendLine(text);
  }

	sendEvent(event: DebugProtocol.Event): void {
		super.sendEvent(event);
		if (event.event !== 'output')
			this.log(LoggingLevel.verbose, `EVENT: ${JSON.stringify(event)}`);
	}
	sendResponse(response: DebugProtocol.Response): void {
		super.sendResponse(response);
		this.log(LoggingLevel.verbose, `RESPONSE: ${JSON.stringify(response)}`);
	}
	sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void{
		super.sendRequest(command, args, timeout, cb);
		this.log(LoggingLevel.verbose, `REQUEST: ${JSON.stringify({command, args})}`);
	}
	dispatchRequest(request: DebugProtocol.Request) {
		this.log(LoggingLevel.verbose, `DISPATCH: ${JSON.stringify(request)}`);
		return super.dispatchRequest(request);
	}

	protected error(text: string): void {
		this.sendEvent(new Adapter.OutputEvent({category: 'important', output: text}))
		console.error(text);
	}

	//-----------------------------------
	// Adapter handlers
	//-----------------------------------

	protected async initializeRequest(_args: DebugProtocol.InitializeRequestArguments) {
		//setTimeout(() => {
		//	this.sendEvent(new Adapter.Event('initialized'));
		//}, 0);

		return this.capabilities;
	}

	protected async launchRequest(args: LaunchRequestArguments) {
		this.useAbsoluteFilePathsForBreakpoints = args.useAbsoluteFilePaths || false;
		this.sharedLibraries		= args.sharedLibraries || [];
		this.postLoadCommands		= args.postLoadCmds || [];
		this.terminateCommands	= args.terminateCmds || [];
	}

	protected async scopesRequest(args: DebugProtocol.ScopesArguments) {
		return {
			scopes: [
				{
					name: 'Locals',
					variablesReference: SCOPE_LOCAL + args.frameId,
					expensive: false,
					presentationHint: 'locals',
				},
				{
					name: 'Registers',
					variablesReference: SCOPE_REGISTERS,
					expensive: true,
					presentationHint: 'registers',
				},
			],
		};
	}

	protected async exceptionInfoRequest(_args: DebugProtocol.ExceptionInfoArguments) {
		const exception = this.lastException;

		if (exception) {
			return {
				exceptionId: exception.name,
				breakMode: 'unhandled' as DebugProtocol.ExceptionBreakMode,
				description: exception.description,
			};
		}
	}

}
