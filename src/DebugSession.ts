import * as vscode from 'vscode';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as Adapter from './DebugAdapter';
import * as path from 'path';

export const SCOPE = {
	GLOBALS:	  99999,
	LOCAL:	    100000,
	STATICS:		200000,
	REGISTERS:	300000,
} as const;

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
	sourceMapping?:				{ [key: string]: string };
}

export type AttachRequestArguments = DebugProtocol.LaunchRequestArguments & {
	debugger:							string;
	capabilities?:				DebugProtocol.Capabilities;
	startupCmds?:					string[];
	postLoadCmds?:				string[];
	terminateCmds?:				string[];
	logging?:							LoggingLevelKeys;
	useAbsoluteFilePaths?: boolean;
	sharedLibraries?:			string[];
}

export function adjustMemory(memoryReference: string, offset?: number): string {
	return offset ? '0x' + (+memoryReference + offset).toString(16) : memoryReference;
}

export function memoryReference(value: string): string | undefined {
	const match = /^(0x[0-9a-fA-F]+)/.exec(value);
	if (match)
		return match[1];
}

function optionalJSON(args: any) {
	return args ? ' ' + JSON.stringify(args) : '';
}

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
	protected sourceMapping:	Record<string, string> = {};
	protected	lastException: DebuggerException | null = null;
	private 	toServer?: {write(command: string): void};

	constructor(private readonly outputChannel: vscode.OutputChannel, _configuration: vscode.DebugConfiguration) {
		super();
		const configuration = _configuration as unknown as LaunchRequestArguments;
		this.capabilities	= {...this.capabilities, ...configuration.capabilities};
		this.logging			= configuration.logging ? LoggingLevel[configuration.logging] : LoggingLevel.off;
		this.useAbsoluteFilePathsForBreakpoints = configuration.useAbsoluteFilePaths || false;
		this.sourceMapping 			= configuration.sourceMapping || {};
		this.sharedLibraries		= configuration.sharedLibraries || [];
		this.postLoadCommands		= configuration.postLoadCmds || [];
		this.terminateCommands	= configuration.terminateCmds || [];

	}

	protected mapSource(fileName: string): string {
		for (const [k, v] of Object.entries(this.sourceMapping)) {
			if (fileName.startsWith(k))
				return v + fileName.slice(k.length);
		}
		return fileName;
	}
	
	protected getNormalizedFileName(fileName: string): string {
		return this.useAbsoluteFilePathsForBreakpoints ? fileName : path.basename(fileName);
	}

	protected abstract recvServer(line: string): void;

	protected sendServer(command: string) {
		this.log(LoggingLevel.verbose, command);
		if (this.toServer)
			this.toServer.write(command + '\n');
	}

	protected setCommunication(input: NodeJS.WritableStream, output: NodeJS.ReadableStream, error?: NodeJS.ReadableStream) {
		this.toServer = input;//process.stdin;

		let outputBuffer = '';
		output.on('data', data => {
			outputBuffer += data.toString('utf8');
			const lines = outputBuffer.split('\n') as string[];
			outputBuffer = lines.pop()!;
			lines.forEach(line => {
				this.log(LoggingLevel.verbose, line);
				this.recvServer(line);
			});
		});

		if (error)
			error.on('data', data => 
				console.log(data.toString())
			);
	}

  public log(level: LoggingLevelValue, text: string | (()=>string)): void {
		if (level <= this.logging)
			this.outputChannel.appendLine(typeof text === 'string' ? text : text());
  }

	sendEvent(event: DebugProtocol.Event): void {
		super.sendEvent(event);
		if (event.event !== 'output')
			this.log(LoggingLevel.basic, () => `EVENT(${event.seq}): ${event.event}${optionalJSON(event.body)}`);
	}
	sendResponse(response: DebugProtocol.Response): void {
		super.sendResponse(response);
		this.log(LoggingLevel.basic, () => `RESPONSE(${response.request_seq},${response.seq}): ${response.command} ${response.success ? 'SUCCESS' : 'FAIL'}(${response.message ?? ''})${optionalJSON(response.body)}`);
	}
	sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): number {
		const seq = super.sendRequest(command, args, timeout, cb);
		this.log(LoggingLevel.basic, () => `REQUEST(${seq}): ${command}${optionalJSON(args)}`);
		return seq;
	}
	dispatchRequest(request: DebugProtocol.Request) {
		this.log(LoggingLevel.basic, () => `DISPATCH(${request.seq}): ${request.command}${optionalJSON(request.arguments)}`);
		return super.dispatchRequest(request);
	}

	//-----------------------------------
	// Adapter handlers
	//-----------------------------------

	protected async initializeRequest(_args: DebugProtocol.InitializeRequestArguments) {
		setTimeout(() => this.sendEvent(new Adapter.InitializedEvent), 0);

		return this.capabilities;
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
