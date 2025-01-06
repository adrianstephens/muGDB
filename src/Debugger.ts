import {spawn} from 'child_process';
import {EventEmitter} from 'events';
import {OutputRecord, ResultRecord} from './gdb/MIParser';

import {CompletionItem, OutputChannel} from 'vscode';
import {AttachRequestArguments, LaunchRequestArguments, DebugLoggingLevel} from './DebugSession';
import {Breakpoint} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import path = require('path');

export const SCOPE_LOCAL = 100000;
export const SCOPE_REGISTERS = 200000;

export const EXCEPTION_THROW = 'throw';
export const EXCEPTION_CATCH = 'catch';

export abstract class DebuggerException {
  public name: string;
  public description: string;
}

export interface DebuggerVariable {
  name: string;
  debuggerName: string;  // The unique "name" assigned by the underlying MI debugger need not be identical to the actual source location name
  numberOfChildren: number;
  referenceID: number;
  value: string;
  type: string;
}

export abstract class Debugger extends EventEmitter {
  protected attachPID?: number;
  protected postLoadCommands: string[] = [];
  protected useAbsoluteFilePathsForBreakpoints: boolean;

  // Should we only load certain libraries?
  protected sharedLibraries: string[] = [];

  // The current thread on which the debugger is stopped on. If the debugger is not currently stopped on any thread, this value is -1.
  protected threadID = -1;

  // Filepaths to input and output pipes used for IPC with debugger process
  protected inferiorInputFileName = '';
  protected inferiorOutputFileName = '';

  protected lastException: DebuggerException | null = null;

  protected toServer: any;

  // Should any debug logging occur?
  protected debug = DebugLoggingLevel.OFF;

  // Is the debugger ready to start accepting commands?
  private ready: () => void;
  protected onDebuggerReady = new Promise<void>(resolve => { this.ready = resolve; });
  protected startupPromises: Promise<void>[] = [];

  // Is it safe to request continued execution of the inferior process?
  protected inferiorRunning = false;

  constructor(
    private readonly outputChannel: OutputChannel,
    protected readonly enableReverseDebugging: boolean
  ) {
    super();
  }

  public async spawn(args: LaunchRequestArguments | AttachRequestArguments): Promise<boolean> {
    this.useAbsoluteFilePathsForBreakpoints = args.useAbsoluteFilePaths || false;
    this.sharedLibraries = args.sharedLibraries || [];
    this.debug = args.debug || DebugLoggingLevel.OFF;

    if (args.request === 'launch') {
      this.postLoadCommands = args.postLoadCmds || [];
    } else {
      this.attachPID = +args.program || -1;
    }

    // Instead of pipes, directly spawn GDB with stdio
    const args2 = this.createDebuggerLaunchCommand(args);

    const gdb = spawn(args2[0], args2.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.toServer = gdb.stdin;

    // Handle GDB output
    let outputBuffer = '';
    gdb.stdout.on('data', data => {
      outputBuffer += data.toString('utf8');
      const lines = outputBuffer.split('\n') as string[];
      outputBuffer = lines.pop()!;
      lines.forEach(line => this.handleOutput(line));
    });

    // Handle GDB stderr
    gdb.stderr.on('data', data => console.log(data.toString()));

    if (args.request === 'launch' && args.startupCmds?.length)
      await Promise.all(args.startupCmds.map(cmd => this.sendCommand(cmd)));

    this.ready();
    await Promise.all(this.startupPromises);
    return true;
  }

  public getLastException(): DebuggerException | null {
    return this.lastException;
  }

  public abstract clearBreakpoints(fileName: string): Promise<boolean>;
  public abstract createVariable(name: string): Promise<DebuggerVariable>;
  public abstract continue(threadID?: number): Promise<OutputRecord>;
  public abstract evaluateExpression(expr: string, frameID?: number): Promise<any>;
  public abstract getStackTrace(threadID: number): Promise<DebugProtocol.StackFrame[]>;
  public abstract getCommandCompletions(command: string): Promise<CompletionItem[]>;
  public abstract getDisassembly(memoryAddress: string): Promise<any>;
  public abstract getThreads(): Promise<any>;
  public abstract getVariable(name: string): DebuggerVariable | undefined;
  public abstract getVariables(referenceID: number): Promise<any>;
  public abstract goto(file: string, line: number): Promise<boolean>;
  public abstract next(threadID: number, granularity: string): Promise<OutputRecord>;
  public abstract pause(threadID?: number, ignorePause?: boolean): Promise<boolean>;
  public abstract sendCommand(command: string): Promise<OutputRecord>;
  public abstract sendUserCommand(command: string, frameID?: number): Promise<ResultRecord>;
  public abstract setBreakpoints(fileName: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<Breakpoint[]>;
  public abstract setExceptionBreakpoints(filter: string[]): Promise<boolean>;
  public abstract setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<Breakpoint[]>;
  public abstract setVariable(referenceID: number, args: DebugProtocol.SetVariableArguments): Promise<OutputRecord | null>;
  public abstract stepIn(threadID: number): Promise<OutputRecord>;
  public abstract stepOut(threadID: number): Promise<OutputRecord>;
  public abstract stepBack(threadID: number): Promise<OutputRecord>;
  public abstract terminate(): Promise<any>;
  public abstract launchInferior(): Promise<void>;
  public abstract reverseContinue(threadID: number): Promise<OutputRecord>;
  protected abstract createDebuggerLaunchCommand(args: LaunchRequestArguments | AttachRequestArguments): string[];
  protected abstract handleOutput(line: string): void;

  public setInferiorLaunched(hasLaunched: boolean) {
    this.inferiorRunning = hasLaunched;
  }

  protected isStopped(threadID?: number): boolean {
    return this.threadID !== -1 && (threadID === undefined || this.threadID === threadID);
  }

  public log(text: string) {
    if (this.debug !== DebugLoggingLevel.OFF)
      this.outputChannel.appendLine(text);
  }

  public sanitize(text: string, MI?: boolean): string {
    text = (text || '')
      .replace(/&"/g, '')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\v/g, '\v')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');

    // If we are sanitizing MI output there are additional things we need to strip out
    if (MI) {
      text = text.replace(/^~"*/g, '').replace(/"$/g, '');

      // TODO: is it safe to do this for both cases??
      text = text.replace(/\\n/g, '\n');
    } else {
      text = text.replace(/\\n/g, '');
    }

    return text;
  }

  protected getNormalizedFileName(fileName: string): string {
    return this.useAbsoluteFilePathsForBreakpoints ? fileName : path.basename(fileName);
  }

}

