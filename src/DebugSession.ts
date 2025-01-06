import * as vscode from 'vscode';
import * as adapter from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {GDB} from './gdb/GDB';

import {
  Debugger,
  DebuggerVariable,
  EXCEPTION_CATCH,
  EXCEPTION_THROW,
  SCOPE_LOCAL,
  SCOPE_REGISTERS,
} from './Debugger';

export const EVENT_OUTPUT               = 'output';
export const EVENT_RUNNING              = 'running';
export const EVENT_BREAKPOINT_HIT       = 'breakpoint-hit';
export const EVENT_END_STEPPING_RANGE   = 'end-stepping-range';
export const EVENT_FUNCTION_FINISHED    = 'function-finished';
export const EVENT_EXITED_NORMALLY      = 'exited-normally';
export const EVENT_SIGNAL               = 'signal-received';
export const EVENT_PAUSED               = 'paused';
export const EVENT_ERROR                = 'error';
export const EVENT_ERROR_FATAL          = 'error-fatal';
export const EVENT_THREAD_NEW           = 'thread-created';

export enum DebugLoggingLevel {
  OFF = 'off',
  BASIC = 'basic',
  VERBOSE = 'verbose',
}

class StoppedEvent extends adapter.StoppedEvent {
  constructor(reason: string, threadID: number, allThreads?: boolean) {
    super(reason, threadID);
    (this.body as any).allThreadsStopped = allThreads;
  }
}

export type LaunchRequestArguments = {request: 'launch'} & DebugProtocol.LaunchRequestArguments & {
  /** Absolute program to path to debug */
  program: string;
  /** program arguments */
  args?: string[];
  /** Debugger path */
  debugger: string;
  /** Debugger arguments */
  debuggerArgs?: string[];
  /** GDB commands to run on startp */
  startupCmds?: string[];
  /** GDB commands to run after connection */
  postLoadCmds?: string[];
  /** How verbose should debug logging be? */
  debug?: DebugLoggingLevel;
  /** Should inferior terminal be in VSCode? */
  externalConsole?: boolean;
  /** Should absolute filepaths be used? */
  useAbsoluteFilePaths?: boolean;
  /** Shared libraries for deferred symbol loading */
  sharedLibraries?: string[];
}

export type AttachRequestArguments = {request: 'attach'} & DebugProtocol.AttachRequestArguments & {
  /** PID of process to debug. */
  program: number;
  /** Debugger path */
  debugger: string;
  /** Debugger arguments */
  debuggerArgs?: string[];
  /** How verbose should debug logging be? */
  debug?: DebugLoggingLevel;
  /** Should inferior terminal be in VSCode? */
  externalConsole?: boolean;
  /** Should absolute filepaths be used? */
  useAbsoluteFilePaths?: boolean;
  /** Shared libraries for deferred symbol loading */
  sharedLibraries?: string[];
}

// This is the main class which implements the debug adapter protocol. It will
// instantiate a separate GDB object which handles spawning and interacting with
// the GDB process (i.e. parsing MI output). The session handles requests and
// responses with the IDE
export class DebugSession extends adapter.DebugSession {
  private debugger: Debugger;

  sendEvent(event: DebugProtocol.Event): void {
    if (event.event !== 'output')
      this.debugger.log(`EVENT: ${JSON.stringify(event)}`);
    super.sendEvent(event);
  }
  sendResponse(response: DebugProtocol.Response): void {
    this.debugger.log(`RESPONSE: ${JSON.stringify(response)}`);
    super.sendResponse(response);
  }
  sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void{
    this.debugger.log(`REQUEST: ${JSON.stringify({command, args})}`);
    super.sendRequest(command, args, timeout, cb);
  }
  dispatchRequest(request: DebugProtocol.Request): void {
    if (this.debugger)
      this.debugger.log(`DISPATCH: ${JSON.stringify(request)}`);
    super.dispatchRequest(request);
  }
  constructor(private readonly outputChannel: vscode.OutputChannel) {
    super();
  }

  /**
   * Create a new debugger and return all capabilities supported by the debug
   * adapter (common functionality across all implemented debuggers)
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ) {
    const enableReverseDebugging = DebugSession.getSettingValue(
      'enableReverseDebugging'
    );

    this.debugger = new GDB(this.outputChannel, enableReverseDebugging);
    this.bindDebuggerEvents();

    response.body = {
      supportsEvaluateForHovers: true,
      supportsSetVariable: true,
      supportsConfigurationDoneRequest: true,
      supportsDisassembleRequest: true,
      supportsSteppingGranularity: true,
      supportsExceptionInfoRequest: true,
      supportsLogPoints: true,
      supportsCompletionsRequest: DebugSession.getSettingValue('enableCommandCompletions'),
      supportsStepBack: enableReverseDebugging,
      supportsFunctionBreakpoints: true,
      supportsGotoTargetsRequest: true,
      exceptionBreakpointFilters: [
        {filter: EXCEPTION_THROW, label: 'Thrown Exceptions'},
        {filter: EXCEPTION_CATCH, label: 'Caught Exceptions'},
      ],
    };

    this.sendResponse(response);
    this.sendEvent(new adapter.InitializedEvent());
  }

  /**
   * Launch debugger and setup correct state for the inferior but do NOT start
   * the actual inferior process. Such process must be started at the end of the
   * configuration sequence, after breakpoints have been set.
   */
  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ) {
    this.debugger.spawn(args).then(() => {
      this.sendResponse(response);
    });
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    args: AttachRequestArguments
  ) {
    this.debugger.spawn(args).then(() => {
      this.sendResponse(response);
    });
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments
  ) {
    this.debugger.launchInferior().then(() => {
      this.debugger.setInferiorLaunched(true);
      this.sendResponse(response);
    //  vscode.commands
    //    .executeCommand('workbench.action.terminal.clear')
    //    .then(() => {
    //      this.sendResponse(response);
    //    });
    });
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    this.debugger
      .setBreakpoints(args.source.path || '', args.breakpoints || [])
      .then(() => {
        this.sendResponse(response);
      });
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    this.debugger.getThreads().then((threads: adapter.Thread[]) => {
      response.body = {
        threads: threads,
      };
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    this.debugger.getStackTrace(args.threadId).then((stack: adapter.StackFrame[]) => {
      response.body = {
        stackFrames: stack,
        totalFrames: stack.length - 1,
      };
      this.sendResponse(response);
    });
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
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
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ) {
    this.debugger
      .getVariables(args.variablesReference)
      .then((vars: Map<number, DebuggerVariable>) => {
        const variables: adapter.Variable[] = [];

        vars.forEach(variable => {
          // If this is a string strip out special chars
          if (typeof variable.value === 'string') {
            variable.value = this.debugger.sanitize(variable.value, false);
          }

          const v: DebugProtocol.Variable = new adapter.Variable(
            variable.name,
            variable.value,
            variable.numberOfChildren ? variable.referenceID : 0
          );

          v.type = variable.type;
          variables.push(v);
        });

        response.body = {
          variables: variables,
        };

        this.sendResponse(response);
      });
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): void {
    this.debugger.next(args.threadId, args.granularity || '').then(() => {
      this.sendResponse(response);
    });
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): void {
    this.debugger.stepIn(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): void {
    this.debugger.stepOut(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    args: DebugProtocol.StepBackArguments
  ): void {
    // TODO: hook up granularity to support reverse debugging at ASM level
    this.debugger.stepBack(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): void {
    this.debugger.continue(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
    args: DebugProtocol.ReverseContinueArguments
  ): void {
    this.debugger.reverseContinue(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments
  ): void {
    this.debugger.pause(args.threadId).then(() => {
      this.sendResponse(response);
    });
  }

  protected disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments
  ): void {
    this.debugger.getDisassembly(args.memoryReference).then(insts => {
      response.body = {
        instructions: insts,
      };

      this.sendResponse(response);
    });
  }

  protected exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse,
    args: DebugProtocol.ExceptionInfoArguments
  ): void {
    const exception = this.debugger.getLastException();

    if (exception) {
      response.body = {
        exceptionId: exception.name,
        breakMode: 'unhandled',
        description: exception.description,
      };
    }

    this.sendResponse(response);
  }

  protected completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments
  ): void {
    this.debugger
      .getCommandCompletions(args.text)
      .then((completions: adapter.CompletionItem[]) => {
        response.body = {
          targets: completions,
        };

        this.sendResponse(response);
      });
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): void {
    // GDB enumerates frames starting from 0
    if (args.frameId) {
      --args.frameId;
    }

    switch (args.context) {
      case 'repl':
        if (args.expression.startsWith('-')) {
          this.debugger.sendCommand(args.expression).then(record => {
            this.sendEvent(
              new adapter.OutputEvent(record.prettyPrint() + '\n', 'console')
            );
          });
        } else {
          this.debugger.sendUserCommand(args.expression, args.frameId);
        }

        // Do not allow UI to react to "paused" state
        /*
        this.debugger.pause(undefined, true).then((wasPaused: boolean) => {
          const isMICommand = args.expression.startsWith('-');

          if (isMICommand) {
            this.debugger.sendCommand(args.expression).then(record => {
              this.sendEvent(
                new adapter.OutputEvent(record.prettyPrint() + '\n', 'console')
              );
            });
          } else {
            this.debugger.sendUserCommand(args.expression, args.frameId);
          }

          if (!wasPaused) {
            this.debugger.continue().then(() => {
              this.sendResponse(response);
            });
          } else {
            this.sendResponse(response);
          }
        });
        */
        break;

      case 'watch':
      case 'hover': {
        const handler = (variable: DebuggerVariable) => {
          response.body = {
            result: variable.value,
            variablesReference: variable.referenceID,
          };

          if (!variable.value) {
            response.success = false;
            response.message = `Variable '${variable.name}' not found`;
          }

          this.sendResponse(response);
        };

        const variable = this.debugger.getVariable(args.expression);

        // If variable is already being tracked, reuse "cached" result
        if (variable) {
          handler(variable);
        } else {
          this.debugger
            .createVariable(args.expression)
            .then((variable: DebuggerVariable) => handler(variable));
        }
      }
    }
  }

  protected setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments
  ): void {
    this.debugger.setVariable(args.variablesReference, args).then(() => {
      response.body = {
        value: args.value,
      };

      this.sendResponse(response);
    });
  }

  protected setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments
  ): void {
    this.debugger.setFunctionBreakpoints(args.breakpoints).then(breakpoints => {
      response.body = {
        breakpoints,
      };

      this.sendResponse(response);
    });
  }

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments
  ): void {
    this.debugger.setExceptionBreakpoints(args.filters).then(() => {
      this.sendResponse(response);
    });
  }

  protected gotoTargetsRequest(
    response: DebugProtocol.GotoTargetsResponse,
    args: DebugProtocol.GotoTargetsArguments
  ): void {
    // TODO: why can source path be empty?
    this.debugger
      .goto(args.source.path || '', args.line)
      .then(() => this.sendResponse(response));
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments
  ): void {
    // If this was an attach request do not kill the inferior
    this.debugger.terminate().then(() => {
      this.sendResponse(response);
    });
  }

  protected log(text: string): void {
    this.outputChannel.appendLine(text);
  }

  protected error(text: string): void {
    console.error(text);

    // We do not cache the value in the adapter's constructor so that any
    // changes can immediately take effect
    if (vscode.workspace.getConfiguration('vgdb').get('showErrorPopup')) {
      vscode.window.showErrorMessage(text);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static getSettingValue(settingName: string): any {
    return vscode.workspace.getConfiguration('vgdb').get(settingName);
  }

  private bindDebuggerEvents(): void {
    // Bind error handler for unexpected GDB errors
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.debugger.on(EVENT_ERROR_FATAL, (error: any) => {
      this.error(
        'vGDB has encountered a fatal error. Please check the vGDB output channel and create an issue at http://www.github.com/penagos/vgdb/issues'
      );
      this.error(error);
      this.sendEvent(new adapter.TerminatedEvent());
    });

    // Pipe to debug console
    this.debugger.on(EVENT_OUTPUT, (text: string, type: string) => {
      // Massage GDB output as much as possible
      this.sendEvent(new adapter.OutputEvent(text, type));
    });

    // Events triggered by debuggeer
    this.debugger.on(EVENT_RUNNING, (threadID: number, allThreads: boolean) => {
      this.sendEvent(new adapter.ContinuedEvent(threadID, allThreads));
    });

    this.debugger.on(EVENT_BREAKPOINT_HIT, (threadID: number, allThreads?: boolean) => {
      this.sendEvent(new StoppedEvent('breakpoint', threadID, allThreads));
    });

    this.debugger.on(EVENT_END_STEPPING_RANGE, (threadID: number, allThreads?: boolean) => {
      this.sendEvent(new StoppedEvent('step', threadID, allThreads));
    });

    this.debugger.on(EVENT_FUNCTION_FINISHED, (threadID: number, allThreads?: boolean) => {
      this.sendEvent(new StoppedEvent('step-out', threadID, allThreads));
    });

    this.debugger.on(EVENT_EXITED_NORMALLY, () => {
      this.sendEvent(new adapter.TerminatedEvent());
    });

    this.debugger.on(EVENT_SIGNAL, (threadID: number, allThreads?: boolean) => {
      this.sendEvent(new StoppedEvent('exception', threadID, allThreads));
    });

    this.debugger.on(EVENT_PAUSED, (threadID: number, allThreads?: boolean) => {
      this.sendEvent(new StoppedEvent('pause', threadID, allThreads));
    });

    this.debugger.on(EVENT_ERROR, (msg: string) => {
      // We do not cache the value in the adapter's constructor so
      // that any changes can immediately take effect
      if (vscode.workspace.getConfiguration('vgdb').get('showErrorPopup')) {
        vscode.window.showErrorMessage(msg);
      }
    });

    this.debugger.on(EVENT_THREAD_NEW, (threadID: number) => {
      this.sendEvent(new adapter.ThreadEvent('started', threadID));
    });
  }
}
