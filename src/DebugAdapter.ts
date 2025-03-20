import * as vscode from 'vscode';
import {DebugProtocol} from '@vscode/debugprotocol';

export class Message implements DebugProtocol.ProtocolMessage {
	seq = 0;
	public constructor(public type: string) {}
}

abstract class EventNoBody extends Message implements DebugProtocol.Event {
	abstract event: string;
	public constructor() {
		super('event');
	}
}

abstract class EventT<T extends DebugProtocol.Event> extends EventNoBody {
	abstract event: string;
	public constructor(public body:	T extends { body?: any} ? T['body'] | void : T['body']) {
		super();
	}
}

export class InitializedEvent		extends EventNoBody									{ event = 'initialized'; }
export class StoppedEvent			extends EventT<DebugProtocol.StoppedEvent>			{ event = 'stopped'; }
export class ContinuedEvent			extends EventT<DebugProtocol.ContinuedEvent>		{ event = 'continued'; }
export class ExitedEvent			extends EventT<DebugProtocol.ExitedEvent>			{ event = 'exited'; }
export class TerminatedEvent		extends EventT<DebugProtocol.TerminatedEvent>		{ event = 'terminated'; }
export class ThreadEvent			extends EventT<DebugProtocol.ThreadEvent>			{ event = 'thread'; }
export class OutputEvent			extends EventT<DebugProtocol.OutputEvent>			{ event = 'output'; }
export class BreakpointEvent		extends EventT<DebugProtocol.BreakpointEvent>		{ event = 'breakpoint'; }
export class ModuleEvent			extends EventT<DebugProtocol.ModuleEvent>			{ event = 'module'; }
export class LoadedSourceEvent		extends EventT<DebugProtocol.LoadedSourceEvent>		{ event = 'loadedSource'; }
export class ProcessEvent			extends EventT<DebugProtocol.ProcessEvent>			{ event = 'process'; }
export class CapabilitiesEvent		extends EventT<DebugProtocol.CapabilitiesEvent>		{ event = 'capabilities'; }
export class ProgressStartEvent		extends EventT<DebugProtocol.ProgressStartEvent>	{ event = 'progressStart'; }
export class ProgressUpdateEvent	extends EventT<DebugProtocol.ProgressUpdateEvent>	{ event = 'progressUpdate'; }
export class ProgressEndEvent		extends EventT<DebugProtocol.ProgressEndEvent>		{ event = 'progressEnd'; }
export class InvalidatedEvent		extends EventT<DebugProtocol.InvalidatedEvent>		{ event = 'invalidated'; }
export class MemoryEvent			extends EventT<DebugProtocol.MemoryEvent>			{ event = 'memory'; }

type ReturnBody<T extends DebugProtocol.Response> = Promise<T['body'] | void>;

export class DebugAdapter implements vscode.DebugAdapter {
	protected client?: DebugProtocol.InitializeRequestArguments;
	
	private _debuggerLinesStart		= 0;
	private _debuggerColumnsStart	= 0;
	private clientLineToDebugger	= 0;
	private clientColumnToDebugger	= 0;

	private	_sequence = 1;
	private _pendingRequests: ((response: DebugProtocol.Response) => void)[] = [];

	private _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>;
	get onDidSendMessage() { return this._onDidSendMessage.event; }

	private send(message: DebugProtocol.ProtocolMessage): void {
		message.seq = this._sequence++;
		this._onDidSendMessage.fire(message);
	}

	public sendEvent(event: DebugProtocol.Event): void {
		this.send(event);
	}

	public sendResponse(response: DebugProtocol.Response): void {
		this.send(response);
	}

	public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void) : number {
		const request = {
			type: 'request',
			command,
			...(args && Object.keys(args).length > 0 && args)
		};

		this.send(request);

		if (cb) {
			this._pendingRequests[request.seq] = cb;

			const timer = setTimeout(() => {
				clearTimeout(timer);
				const clb = this._pendingRequests[request.seq];
				if (clb) {
					delete this._pendingRequests[request.seq];
					clb({
						seq:		0,
						type:		'response',
						request_seq: request.seq,
						command:	request.command,
						message:	'timeout',
						success:	false,
					});
				}
			}, timeout);
		}
		return request.seq;
	}

	protected error(text: string): void {
		this.sendEvent(new OutputEvent({category: 'important', output: text}));
	}

	handleMessage(message: DebugProtocol.ProtocolMessage): void {
		if (message.type === 'request') {
			const request = message as DebugProtocol.Request;
			this.dispatchRequest(request)
				.then(body => {
					this.sendResponse({
						seq:		0,
						type:		'response',
						request_seq: request.seq,
						command:	request.command,
						success:	true,
						...(body && {body})
					});
				})
				.catch((err: any) => {
					this.sendResponse({
						seq:		0,
						type:		'response',
						request_seq: request.seq,
						command:	request.command,
						success:	false,
						message:	typeof err === 'string' ? err : err.message
					});
				});

		} else if (message.type === 'response') {
			const response = message as DebugProtocol.Response;
			const clb = this._pendingRequests[response.request_seq];
			if (clb) {
				delete this._pendingRequests[response.request_seq];
				clb(response);
			}
		}
	}

	dispatchRequest(request: DebugProtocol.Request): Promise<any> {
		switch (request.command) {
			case 'cancel':						return this.cancelRequest(request.arguments);
			case 'runInTerminal':				return this.runInTerminalRequest(request.arguments);
			case 'startDebugging':				return this.startDebuggingRequest(request.arguments);
			case 'initialize':					return this.initializeRequest0(request.arguments);
			case 'configurationDone':			return this.configurationDoneRequest(request.arguments);
			case 'launch':						return this.launchRequest(request.arguments);
			case 'attach':						return this.attachRequest(request.arguments);
			case 'restart':						return this.restartRequest(request.arguments);
			case 'disconnect':					return this.disconnectRequest(request.arguments);
			case 'terminate':					return this.terminateRequest(request.arguments);
			case 'breakpointLocations':			return this.breakpointLocationsRequest(request.arguments);
			case 'setBreakpoints':				return this.setBreakpointsRequest(request.arguments);
			case 'setFunctionBreakpoints':		return this.setFunctionBreakpointsRequest(request.arguments);
			case 'setExceptionBreakpoints':		return this.setExceptionBreakpointsRequest(request.arguments);
			case 'dataBreakpointInfo':			return this.dataBreakpointInfoRequest(request.arguments);
			case 'setDataBreakpoints':			return this.setDataBreakpointsRequest(request.arguments);
			case 'setInstructionBreakpoints':	return this.setInstructionBreakpointsRequest(request.arguments);
			case 'continue':					return this.continueRequest(request.arguments);
			case 'next':						return this.nextRequest(request.arguments);
			case 'stepIn':						return this.stepInRequest(request.arguments);
			case 'stepOut':						return this.stepOutRequest(request.arguments);
			case 'stepBack':					return this.stepBackRequest(request.arguments);
			case 'reverseContinue':				return this.reverseContinueRequest(request.arguments);
			case 'restartFrame':				return this.restartFrameRequest(request.arguments);
			case 'goto':						return this.gotoRequest(request.arguments);
			case 'pause':						return this.pauseRequest(request.arguments);
			case 'stackTrace':					return this.stackTraceRequest(request.arguments);
			case 'scopes':						return this.scopesRequest(request.arguments);
			case 'variables':					return this.variablesRequest(request.arguments);
			case 'setVariable':					return this.setVariableRequest(request.arguments);
			case 'source':						return this.sourceRequest(request.arguments);
			case 'threads':						return this.threadsRequest();
			case 'terminateThreads':			return this.terminateThreadsRequest(request.arguments);
			case 'modules':						return this.modulesRequest(request.arguments);
			case 'loadedSources':				return this.loadedSourcesRequest(request.arguments);
			case 'evaluate':					return this.evaluateRequest(request.arguments);
			case 'setExpression':				return this.setExpressionRequest(request.arguments);
			case 'stepInTargets':				return this.stepInTargetsRequest(request.arguments);
			case 'gotoTargets':					return this.gotoTargetsRequest(request.arguments);
			case 'completions':					return this.completionsRequest(request.arguments);
			case 'exceptionInfo':				return this.exceptionInfoRequest(request.arguments);
			case 'readMemory':					return this.readMemoryRequest(request.arguments);
			case 'writeMemory':					return this.writeMemoryRequest(request.arguments);
			case 'disassemble':					return this.disassembleRequest(request.arguments);
			case 'locations':					return this.locationsRequest(request.arguments);
			default:							return this.customRequest(request.command, request.arguments);
		}
	}

	private async initializeRequest0(args: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
		this.client = args;
		const clientLinesStart		= typeof args.linesStartAt1 === 'boolean' ? 1 : 0;
		const clientColumnsStart	= typeof args.columnsStartAt1 === 'boolean' ? 1 : 0;

		this.clientLineToDebugger	= this._debuggerLinesStart - clientLinesStart;
		this.clientLineToDebugger	= this._debuggerColumnsStart - clientColumnsStart;

		return this.initializeRequest(args);
	}

	protected async initializeRequest(_args: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
		return {
			supportsConditionalBreakpoints:		false,
			supportsHitConditionalBreakpoints:	false,
			supportsFunctionBreakpoints:		false,
			supportsConfigurationDoneRequest:	true,
			supportsEvaluateForHovers:			false,
			supportsStepBack:					false,
			supportsSetVariable:				false,
			supportsRestartFrame:				false,
			supportsStepInTargetsRequest:		false,
			supportsGotoTargetsRequest:			false,
			supportsCompletionsRequest:			false,
			supportsRestartRequest:				false,
			supportsExceptionOptions:			false,
			supportsValueFormattingOptions:		false,
			supportsExceptionInfoRequest:		false,
			supportTerminateDebuggee:			false,
			supportsDelayedStackTraceLoading:	false,
			supportsLoadedSourcesRequest:		false,
			supportsLogPoints:					false,
			supportsTerminateThreadsRequest:	false,
			supportsSetExpression:				false,
			supportsTerminateRequest:			false,
			supportsDataBreakpoints:			false,
			supportsReadMemoryRequest:			false,
			supportsDisassembleRequest:			false,
			supportsCancelRequest:				false,
			supportsBreakpointLocationsRequest: false,
			supportsClipboardContext:			false,
			supportsSteppingGranularity:		false,
			supportsInstructionBreakpoints:		false,
			supportsExceptionFilterOptions:		false,
		};
	}

	protected async cancelRequest						(_args: DebugProtocol.CancelArguments):						ReturnBody<DebugProtocol.CancelResponse>					{ return; }
	protected async runInTerminalRequest				(_args: DebugProtocol.RunInTerminalRequestArguments):		ReturnBody<DebugProtocol.RunInTerminalResponse>				{ return; }
	protected async startDebuggingRequest				(_args: DebugProtocol.StartDebuggingRequestArguments):		ReturnBody<DebugProtocol.StartDebuggingResponse>			{ return; }
//	protected async initializeRequest					(_args: DebugProtocol.InitializeRequestArguments):			ReturnBody<DebugProtocol.InitializeResponse>				{ return; }
	protected async configurationDoneRequest			(_args: DebugProtocol.ConfigurationDoneArguments):			ReturnBody<DebugProtocol.ConfigurationDoneResponse>			{ return; }
	protected async launchRequest						(_args: DebugProtocol.LaunchRequestArguments):				ReturnBody<DebugProtocol.LaunchResponse>					{ return; }
	protected async attachRequest						(_args: DebugProtocol.AttachRequestArguments):				ReturnBody<DebugProtocol.AttachResponse>					{ return; }
	protected async restartRequest						(_args: DebugProtocol.RestartArguments):					ReturnBody<DebugProtocol.RestartResponse>					{ return; }
	protected async disconnectRequest					(_args: DebugProtocol.DisconnectArguments):					ReturnBody<DebugProtocol.DisconnectResponse>				{ return; }
	protected async terminateRequest					(_args: DebugProtocol.TerminateArguments):					ReturnBody<DebugProtocol.TerminateResponse>					{ return; }
	protected async breakpointLocationsRequest			(_args: DebugProtocol.BreakpointLocationsArguments):		ReturnBody<DebugProtocol.BreakpointLocationsResponse>		{ return; }
	protected async setBreakpointsRequest				(_args: DebugProtocol.SetBreakpointsArguments):				ReturnBody<DebugProtocol.SetBreakpointsResponse>			{ return; }
	protected async setFunctionBreakpointsRequest		(_args: DebugProtocol.SetFunctionBreakpointsArguments):		ReturnBody<DebugProtocol.SetFunctionBreakpointsResponse>	{ return; }
	protected async setExceptionBreakpointsRequest		(_args: DebugProtocol.SetExceptionBreakpointsArguments):	ReturnBody<DebugProtocol.SetExceptionBreakpointsResponse>	{ return; }
	protected async dataBreakpointInfoRequest			(_args: DebugProtocol.DataBreakpointInfoArguments):			ReturnBody<DebugProtocol.DataBreakpointInfoResponse>		{ return; }
	protected async setDataBreakpointsRequest			(_args: DebugProtocol.SetDataBreakpointsArguments):			ReturnBody<DebugProtocol.SetDataBreakpointsResponse>		{ return; }
	protected async setInstructionBreakpointsRequest	(_args: DebugProtocol.SetInstructionBreakpointsArguments):	ReturnBody<DebugProtocol.SetInstructionBreakpointsResponse>	{ return; }
	protected async continueRequest						(_args: DebugProtocol.ContinueArguments):					ReturnBody<DebugProtocol.ContinueResponse>					{ return; }
	protected async nextRequest							(_args: DebugProtocol.NextArguments):						ReturnBody<DebugProtocol.NextResponse>						{ return; }
	protected async stepInRequest						(_args: DebugProtocol.StepInArguments):						ReturnBody<DebugProtocol.StepInResponse>					{ return; }
	protected async stepOutRequest						(_args: DebugProtocol.StepOutArguments):					ReturnBody<DebugProtocol.StepOutResponse>					{ return; }
	protected async stepBackRequest						(_args: DebugProtocol.StepBackArguments):					ReturnBody<DebugProtocol.StepBackResponse>					{ return; }
	protected async reverseContinueRequest				(_args: DebugProtocol.ReverseContinueArguments):			ReturnBody<DebugProtocol.ReverseContinueResponse>			{ return; }
	protected async restartFrameRequest					(_args: DebugProtocol.RestartFrameArguments):				ReturnBody<DebugProtocol.RestartFrameResponse>				{ return; }
	protected async gotoRequest							(_args: DebugProtocol.GotoArguments):						ReturnBody<DebugProtocol.GotoResponse>						{ return; }
	protected async pauseRequest						(_args: DebugProtocol.PauseArguments):						ReturnBody<DebugProtocol.PauseResponse>						{ return; }
	protected async stackTraceRequest					(_args: DebugProtocol.StackTraceArguments):					ReturnBody<DebugProtocol.StackTraceResponse>				{ return; }
	protected async scopesRequest						(_args: DebugProtocol.ScopesArguments):						ReturnBody<DebugProtocol.ScopesResponse>					{ return; }
	protected async variablesRequest					(_args: DebugProtocol.VariablesArguments):					ReturnBody<DebugProtocol.VariablesResponse>					{ return; }
	protected async setVariableRequest					(_args: DebugProtocol.SetVariableArguments):				ReturnBody<DebugProtocol.SetVariableResponse>				{ return; }
	protected async sourceRequest						(_args: DebugProtocol.SourceArguments):						ReturnBody<DebugProtocol.SourceResponse>					{ return; }
	protected async threadsRequest						():															ReturnBody<DebugProtocol.ThreadsResponse>					{ return; }
	protected async terminateThreadsRequest				(_args: DebugProtocol.TerminateThreadsArguments):			ReturnBody<DebugProtocol.TerminateThreadsResponse>			{ return; }
	protected async modulesRequest						(_args: DebugProtocol.ModulesArguments):					ReturnBody<DebugProtocol.ModulesResponse>					{ return; }
	protected async loadedSourcesRequest				(_args: DebugProtocol.LoadedSourcesArguments):				ReturnBody<DebugProtocol.LoadedSourcesResponse>				{ return; }
	protected async evaluateRequest						(_args: DebugProtocol.EvaluateArguments):					ReturnBody<DebugProtocol.EvaluateResponse>					{ return; }
	protected async setExpressionRequest				(_args: DebugProtocol.SetExpressionArguments):				ReturnBody<DebugProtocol.SetExpressionResponse>				{ return; }
	protected async stepInTargetsRequest				(_args: DebugProtocol.StepInTargetsArguments):				ReturnBody<DebugProtocol.StepInTargetsResponse>				{ return; }
	protected async gotoTargetsRequest					(_args: DebugProtocol.GotoTargetsArguments):				ReturnBody<DebugProtocol.GotoTargetsResponse>				{ return; }
	protected async completionsRequest					(_args: DebugProtocol.CompletionsArguments):				ReturnBody<DebugProtocol.CompletionsResponse>				{ return; }
	protected async exceptionInfoRequest				(_args: DebugProtocol.ExceptionInfoArguments):				ReturnBody<DebugProtocol.ExceptionInfoResponse>				{ return; }
	protected async readMemoryRequest					(_args: DebugProtocol.ReadMemoryArguments):					ReturnBody<DebugProtocol.ReadMemoryResponse>				{ return; }
	protected async writeMemoryRequest					(_args: DebugProtocol.WriteMemoryArguments):				ReturnBody<DebugProtocol.WriteMemoryResponse>				{ return; }
	protected async disassembleRequest					(_args: DebugProtocol.DisassembleArguments):				ReturnBody<DebugProtocol.DisassembleResponse>				{ return; }
	protected async locationsRequest					(_args: DebugProtocol.LocationsArguments):					ReturnBody<DebugProtocol.LocationsResponse>					{ return; }

	protected customRequest(_command: string, _args: any): Promise<any> {
		throw 'unrecognized request';
	}

	protected convertClientLineToDebugger(line: number): number {
		return line + this.clientLineToDebugger;
	}

	protected convertDebuggerLineToClient(line: number): number {
		return line - this.clientLineToDebugger;
	}

	protected convertClientColumnToDebugger(column: number): number {
		return column + this.clientColumnToDebugger;
	}

	protected convertDebuggerColumnToClient(column: number): number {
		return column - this.clientColumnToDebugger;
	}

	dispose() {
	}
}
