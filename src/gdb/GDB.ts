import path = require('path');
import {CompletionItem} from 'vscode';
import {Breakpoint, Source, StackFrame, Thread} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';

import {
  Debugger,
  DebuggerException,
  DebuggerVariable,
  SCOPE_LOCAL,
  SCOPE_REGISTERS,
} from '../Debugger';

import {ERROR, MIParser, RUNNING, STOPPED, OutputRecord, ResultRecord, StreamRecord, AsyncRecord, AsyncRecordType} from './MIParser';
import {
  EVENT_ERROR_FATAL,
  EVENT_OUTPUT,
  EVENT_RUNNING,
  EVENT_BREAKPOINT_HIT,
  EVENT_END_STEPPING_RANGE,
  EVENT_FUNCTION_FINISHED,
  EVENT_EXITED_NORMALLY,
  EVENT_SIGNAL,
  EVENT_PAUSED,
  EVENT_ERROR,
  EVENT_THREAD_NEW,
  AttachRequestArguments, LaunchRequestArguments
} from '../DebugSession';


const EVENT_SOLIB_LOADED = 'library-loaded';
const EVENT_SOLIB_ADD = 'solib-event';

interface Register {
  name:    string,
  rel?:    number,
  offset?: number,
  size?:   number,
  type?:   string,
  groups?: string[]
};

class GDBException extends DebuggerException {
  name: string;
  location: string;

  constructor(record: OutputRecord) {
    super();
    const frame = record.getResult('frame');
    (this.name = `${record.getResult('signal-meaning')} (${record.getResult(
      'signal-name'
    )})`),
      (this.location = `${frame.addr} in ${frame.func} at ${frame.file}:${frame.line}`);
  }
}

class Deferred {
  private promise = Promise.resolve();
  private resolver?: () => void;

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
 
  then(onfulfilled?: () => void) {
    return this.promise.then(onfulfilled);
  }
}

export class CancellablePromise<T> extends Promise<T> {
  public cancel: (reason?: any) => void;
  constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => (reason?: any) => void) {
    let _cancel: () => void;
    super((resolve, reject) => {
      _cancel = executor(resolve, reject);
    });
    this.cancel	= _cancel!;
  }
}

function combineSparse<T>(a: T[], b: T[]) {
  Object.entries(b).forEach(([i, v]) => a[i] = v);
}

export class GDB extends Debugger {
  // Default path to MI debugger. If none is specified in the launch config we will fallback to this path
  protected debuggerPath = 'gdb';

  // This instance will handle all MI output parsing
  private parser: MIParser = new MIParser();

  // Used to sync MI inputs and outputs. Value increases by 1 with each command issued
  private token = 0;

  // Libraries for which debugger has loaded debug symbols for
  private loadedLibraries = new Map<string, boolean>();

  // Callbacks to execute when a command identified by "token" is resolved by the debugger
  private handlers: {[token: number]: (record: OutputRecord) => void} = [];

  private breakpoints: Record<string, number[]> = {};
  private logBreakpoints: Record<number, string> = {};
  private functionBreakpoints: Record<string, number> = {};
  private exceptionBreakpoints: Record<string, number> = {};

  // Mapping of symbolic variable names to GDB variable references
  private variables: DebuggerVariable[] = [];

  // Mapping of register numbers to their names
  private registers: Register[] = [];

  private ignorePause = false;
  private stopped = new Deferred;
  private capture?: string[];

  protected handleOutput(line: string): void {
    try {
      const record = this.parser.parse(line);
      if (record)
        this.handleParsedResult(record);
    } catch (error: unknown) {
      this.emit(EVENT_ERROR_FATAL, error);
    }
  }

  private handleParsedResult(record: OutputRecord) {
    switch (record.constructor) {
      case AsyncRecord:
        this.handleAsyncRecord(record as AsyncRecord);
        break;

      case ResultRecord:
        this.handleResultRecord(record as ResultRecord);
        break;

      case StreamRecord:
        this.handleStreamRecord(record as StreamRecord);
        break;
    }
  }

  private handleStreamRecord(record: StreamRecord) {
    if (this.capture)
      this.capture.push(record.prettyPrint());
    // Forward raw GDB output to debug console
    this.emit(
      EVENT_OUTPUT,
      this.sanitize(record.prettyPrint(), true),
      'console'
    );
  }

  private handleResultRecord(record: ResultRecord) {
    if (!isNaN(record.token)) {
      const handler = this.handlers[record.token];

      if (handler) {
        handler(record);
        delete this.handlers[record.token];
      } else {
        // There could be instances where we should fire DAP events even if the request did not originally contain
        // a handler. For example, up/down should correctly move the active stack frame in VSCode
      }
    }
  }

  private handleAsyncRecord(record: AsyncRecord) {
    this.log(record.prettyPrint());

    switch (record.type) {
      case AsyncRecordType.EXEC:
        switch (record.klass) {
          case STOPPED: {
            const stoppedReason = record.getResult('reason');
            const allStopped = record.getResult('stopped-threads')==='all';
            this.threadID = parseInt(record.getResult('thread-id'));

            // No stopped reason is emitted when reverse debugging occurs
            if (!stoppedReason) {
              if (this.attachPID || this.enableReverseDebugging)
                this.emit(EVENT_BREAKPOINT_HIT, this.threadID);
              return;
            }

            switch (stoppedReason) {
              case EVENT_BREAKPOINT_HIT:
              case EVENT_END_STEPPING_RANGE:
              case EVENT_FUNCTION_FINISHED:
                // These events don't necessitate any special changes on the debugger itself. Simply bubble up the event
                // to the debug session. If this is the result of a logging breakpoint, do not stop
                if (stoppedReason === EVENT_BREAKPOINT_HIT) {
                  const bkpt = record.getResult('bkptno');
                  const msg = this.logBreakpoints[bkpt];

                  if (msg) {
                    this.printLogPoint(msg).then(msgFormtted => {
                      this.emit(EVENT_OUTPUT, msgFormtted, 'stdout');
                    });
                  }
                }

                this.emit(stoppedReason, this.threadID, allStopped);
                this.stopped.resolve();
                break;

              case EVENT_EXITED_NORMALLY:
                // The inferior has finished execution. Take down the debugger and inform the debug session that there is nothing else to debug.
                this.sendCommand('quit');
                this.emit(EVENT_EXITED_NORMALLY);
                break;

              case EVENT_SIGNAL:
                if (!this.ignorePause) {
                  if (record.getResult('signal-meaning') === 'Interrupt') {
                    this.emit(EVENT_PAUSED, this.threadID, allStopped);
                  } else {
                    this.lastException = new GDBException(record);
                    this.emit(EVENT_SIGNAL, this.threadID, allStopped);
                  }
                }
                this.stopped.resolve();
                break;

              case EVENT_SOLIB_ADD:
                // This event will only be hit if the user has explicitly specified a set of shared libraries
                // for deferred symbol loading so we need not check for the presence of such setting
                this.sharedLibraries.forEach((library: string) => {
                  if (this.loadedLibraries.get(library)) {
                    this.sendCommand(`sharedlibrary ${library}`);
                    // Do not load shared libraries more than once
                    // This is more of a standing hack, and should be revisited with a more robust solution as a shared
                    // library could be closed by the inferior and need to be reloaded again (i.e. we must add it back)
                    this.loadedLibraries.delete(library);
                  }
                });

                this.continue();
                break;

              default:
                throw new Error('Unknown stop reason');
            }
            break;
        }

          case RUNNING: {
            // When the inferior resumes execution, remove all tracked variables which were used to service variable reference IDs
            const threadID = record.getResult('thread-id');
            if (threadID === 'all' || this.threadID == threadID) {
              this.emit(EVENT_RUNNING, this.threadID, threadID === 'all');
              this.threadID = -1;
              this.clearDebuggerVariables();
              this.stopped.reset()
            }
            break;
          }
        }
        break;

      case AsyncRecordType.NOTIFY:
        // Listen for thread events
        switch (record.klass) {
          case EVENT_THREAD_NEW:
            this.emit(EVENT_THREAD_NEW, record.getResult('id'));
            break;
  
          case EVENT_SOLIB_LOADED: {
            // If deferred symbol loading is enabled, check that the
            // shared library loaded is in the user specified list.
            const libLoaded = path.basename(record.getResult('id'));
            if (this.sharedLibraries.indexOf(libLoaded) > -1) {
              this.loadedLibraries.set(libLoaded, true);
            }
            break;
          }
        }
        break;

      case AsyncRecordType.STATUS:
        // TODO
        break;
    }
  }

  public async launchInferior(): Promise<void> {
    const record = await this.sendCommand('-data-list-register-names');
    this.registers = record.getResult('register-names').map((name: string) => ({name}));

    this.capture = [];
    await this.sendCommand('-interpreter-exec console "maintenance print register-groups"');
    const re = /^\s*(\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\w+,]+)/;
    this.capture.map(line => re.exec(line)).filter(match => match).forEach(match => {
      this.registers[parseInt(match![2])] = {
        name: match![1],
        rel:    parseInt(match![3]),
        offset: parseInt(match![4]),
        size:   parseInt(match![5]),
        type:   match![6],
        groups: match![7].split(',')
      };
    });
    this.capture = undefined;

    if (this.sharedLibraries.length) {
      await Promise.all([
        this.sendCommand('-gdb-set stop-on-solib-events 1'),
        this.sendCommand('-gdb-set auto-solib-add off'),
      ]);

      // Selectively load libraries
      await Promise.all(this.sharedLibraries.map(library => this.sendCommand(`sharedlibrary ${library}`)));

    } else {
      const result: OutputRecord = await this.sendCommand('-gdb-show auto-solib-add');
      if (result.getResult('value') !== 'off') {
        await this.sendCommand('sharedlibrary');
      }
    }

    await Promise.all(this.postLoadCommands.map(cmd => this.sendCommand(cmd)));
  }

  public async clearBreakpoints(fileName: string): Promise<boolean> {
    const pending: Promise<OutputRecord>[] = [];
    const breakpoints = this.breakpoints[fileName];
    if (breakpoints) {
      breakpoints.forEach((breakpoint: number) => {
        pending.push(this.sendCommand(`-break-delete ${breakpoint}`));

        if (this.logBreakpoints[breakpoint])
          delete this.logBreakpoints[breakpoint];
      });

      await Promise.all(pending);
      delete this.breakpoints.fileName;
    }
    return true;
  }

  public continue(threadID?: number): Promise<any> {
    this.ignorePause = false;

    if (threadID) {
      return this.sendCommand(`-exec-continue --thread ${threadID}`);
    } else {
      return this.sendCommand('-exec-continue');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public reverseContinue(threadID?: number): Promise<any> {
    return this.sendCommand('rc');
  }

  public async getStackTrace(threadID: number): Promise<DebugProtocol.StackFrame[]> {
    const record = await this.sendCommand(`-stack-list-frames --thread ${threadID}`) as ResultRecord;
    const stackFinal: DebugProtocol.StackFrame[] = [];
    record.getResult('stack').forEach((frame: any) => {
      frame = frame[1];

      const sf: DebugProtocol.StackFrame = new StackFrame(
        threadID + parseInt(frame.level),
        frame.func,
        new Source(
          frame.file
            ? frame.file.split('\\').pop().split('/').pop()
            : '??',
          frame.fullname
        ),
        parseInt(frame.line)
      );

      sf.instructionPointerReference = frame.addr;
      stackFinal.push(sf);
    });

    return stackFinal;
  }

  public async getCommandCompletions(command: string): Promise<CompletionItem[]> {
    const record = await this.sendCommand(`-complete "${command}"`);
    const items: CompletionItem[] = [];
    record.getResult('matches').forEach((match: string) => {
      items.push(new CompletionItem(match, 0));
    });

    return items;
  }

  public async getDisassembly(
    memoryAddress: string
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    const record = await this.sendCommand(`-data-disassemble -a ${memoryAddress} -- 0`);
    const insts = record.getResult('asm_insns');
    const dasm: DebugProtocol.DisassembledInstruction[] = [];

    insts.forEach(inst => {
      const instDasm: DebugProtocol.DisassembledInstruction = {
        address: inst.address,
        instruction: inst.inst,
      };

      dasm.push(instDasm);
    });
    return dasm;
  }

  public async getThreads(): Promise<Thread[]> {
    const record = await this.sendCommand('-thread-info');
    const threadsResult: Thread[] = [];
    record.getResult('threads').forEach((thread: any) => {
      threadsResult.push(new Thread(parseInt(thread.id), thread.name));
    });
    return threadsResult;
  }

  public getVariable(name: string): DebuggerVariable | undefined {
    return [...this.variables.values()].find(variable => variable.name === name);
  }

  public async setVariable(
    referenceID: number,
    args: DebugProtocol.SetVariableArguments
  ): Promise<OutputRecord | null> {
    const variable = this.variables[this.getNormalizedVariableID(referenceID)];

    // This should always hit in the map. If it doesn't however, do not allow
    // the updating of this variable
    if (variable) {
      let accessName = variable.debuggerName;
      if (args.name !== variable.name) {
        accessName = `${accessName}.${args.name}`;
      }
      return this.sendCommand(`-var-assign ${accessName} ${args.value}`);
    } else {
      return null;
    }
  }

  // This is invoked for requesting all variables in all scopes. To distinguish how we query the debugger, rely on artifically large scope identifiers

  public async getVariables(referenceID: number): Promise<DebuggerVariable[]> {
    // Recursive method to correctly fetch children of pseudo scopes introduced by the underlying MI debugger
    const getVariableChildren = async (variableName: string) => {
      const children = await this.sendCommand(`-var-list-children --simple-values "${variableName}"`);
      const childrenVariables: DebuggerVariable[] = [];

      // Safety check
      if (parseInt(children.getResult('numchild'))) {
        const pending: Promise<any>[] = [];

        children.getResult('children').forEach(child => {
          // Check to see if this is a pseudo child on an aggregate type such as private, public, protected, etc. If so, traverse into
          // child and annotate its consituents with such attribute for special treating by the front-end. Note we could have mulitple
          // such pseudo-levels at a given level
          if (this.isPseudoVariableChild(child[1])) {
            const pseudoPromise = getVariableChildren(child[1].name);
            pseudoPromise.then(variables => combineSparse(childrenVariables, variables));
            pending.push(pseudoPromise);

          } else {
            const newVariable: DebuggerVariable = {
              name:             child[1].exp,
              debuggerName:     child[1].name,
              numberOfChildren: parseInt(child[1].numchild) || (parseInt(child[1].dynamic) && child[1].displayhint !== 'string' ? 1 : 0), // TODO: hacky -- revisit this
              referenceID:      this.variables.length + 1 + childrenVariables.length + 1,
              value:            child[1].value || '',
              type:             child[1].type,
            };

            childrenVariables[newVariable.referenceID] = newVariable;
          }
        });
        await Promise.all(pending);
        combineSparse(this.variables, childrenVariables);
      }
      return childrenVariables;

    };

    if (referenceID < SCOPE_LOCAL) {
      // Fetch children variables for an existing variable
      const variable = this.variables[referenceID];
      return (variable && await getVariableChildren(variable.debuggerName)) ?? []

    } else if (referenceID < SCOPE_REGISTERS) {
      // Fetch root level locals
      await this.clearDebuggerVariables();
      const frameID = referenceID - SCOPE_LOCAL - this.threadID;
      const record = await this.sendCommand(`-stack-list-variables --thread ${this.threadID} --frame ${frameID} --no-frame-filters --simple-values`);

      // Ask GDB to create a new variable so we can correctly display nested variables via reference IDs.
      // When execution is resumed, delete all temporarily created variables to avoid polluting future breaks
      await Promise.all(record.getResult('variables').map(variable => this.createVariable(variable.name)));
      // Resolve outer promise once all prior promises have completed
      return this.variables;

    } else {
      // Fetch registers -- TODO: group registers like variables
      const record = await this.sendCommand('-data-list-register-values r');
      return record.getResult('register-values')
        .filter((reg: any) => this.registers[reg.number]?.groups?.includes('general'))
        .map((reg: any) => ({name: this.registers[reg.number].name, value: reg.value}))
    }
  }

  public next(threadID: number, granularity: string): Promise<OutputRecord> {
    if (granularity === 'instruction') {
      return this.sendCommand(`-exec-next-instruction --thread ${threadID}`);
    } else {
      // Treat a line as being synonymous with a statement
      return this.sendCommand(`-exec-next --thread ${threadID}`);
    }
  }

  public async pause(threadID?: number, ignorePause?: boolean): Promise<boolean> {
    if (this.isStopped(threadID))
      return true;

    if (ignorePause)
      this.ignorePause = true;

    await this.sendCommand(`-exec-interrupt ${threadID || ''}`);
    return false;
  }

  public sendCommand(command: string): Promise<OutputRecord> {
    command = `${++this.token + command}\n`;
    this.log(command);

    return new Promise(resolve => {
      this.toServer.write(command);

      this.handlers[this.token] = (record: OutputRecord) => {
        this.log(record.prettyPrint());
        resolve(record);
      };
    });
  }

  public async sendUserCommand(command: string, frameID?: number): Promise<ResultRecord> {
    let cmd = '-interpreter-exec';

    if (frameID) {
      // "normalize" frameID with threadID
      frameID = frameID - this.threadID + 1;
      cmd = `${cmd} --frame ${frameID} --thread ${this.threadID}`;
    }

    // Escape any quotes in user input
    cmd = `${cmd} console "${this.escapeQuotes(command)}"`;

    const record = await this.sendCommand(cmd) as ResultRecord;
    // If an error has resulted, also send an error event to show it to the user
    if (record.klass === ERROR) {
      this.emit(
        EVENT_ERROR,
        this.escapeEscapeCharacters(record.getResult('msg'))
      );
    }

    // TODO: if this was a stack navigation command, update the callstack with the correct newly selected stackframe. Currently, the debug
    // adapter protocol does not support such behavior. See:
    // https://github.com/microsoft/debug-adapter-protocol/issues/118
    return record;
  }

  public async evaluateExpression(expr: string, frameID?: number): Promise<any> {
    let cmd = '-data-evaluate-expression';

    if (frameID) {
      // "normalize" frameID with threadID
      frameID = frameID - this.threadID + 1;
      cmd += ` --frame ${frameID} --thread ${this.threadID}`;
    }

    cmd += ` "${expr}"`;

    const record = await this.sendCommand(cmd) as ResultRecord;
    const r = record.getResult('value');

    return r ? this.sanitize(r, false) : null;
  }

  public async setExceptionBreakpoints(filter: string[]): Promise<boolean> {
    await this.clearExceptionBreakpoints();
    await Promise.all(filter.map(type =>
      this.sendCommand(`-catch-${type}`).then(result => {
        this.exceptionBreakpoints[type] = result.getResult('bkpt').number;
      })
    ));

    return true;
  }

  public async setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<Breakpoint[]> {
    await this.clearFunctionBreakpoints();
    const breakpointsConfirmed: Breakpoint[] = [];

    await Promise.all(breakpoints.map(breakpoint =>
      this.sendCommand(`-break-insert ${breakpoint.name}`).then(result => {
        const bkpt = result.getResult('bkpt');
        this.functionBreakpoints[breakpoint.name] = bkpt.number;

        breakpointsConfirmed.push(
          new Breakpoint(!bkpt.pending, bkpt.line)
        );
      })
    ));

    return breakpointsConfirmed;
  }

  public async setBreakpoints(
    fileName: string,
    breakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<Breakpoint[]> {

    const getBreakpointInsertionCommand = (fileName: string, breakpoint: DebugProtocol.SourceBreakpoint): string => {
      let cmd = `-f ${fileName}:${breakpoint.line}`;

      if (breakpoint.condition)
        cmd = `-c "${this.escapeQuotes(breakpoint.condition)}" ${cmd}`;
      else if (breakpoint.hitCondition)
        cmd = `-i ${breakpoint.hitCondition} ${cmd}`;

      return `-break-insert ${cmd}`;
    };

    const promise = this.onDebuggerReady.then(async () => {
      // There are instances where breakpoints won't properly bind to source locations
      // despite enabling async mode on GDB. To ensure we always bind to source, explicitly
      // pause the debugger, but do not react to the signal from the UI side so as to
      // not get the UI in an odd state
      const wasPaused = await this.pause(undefined, true);
      await this.stopped;
      //await this.stopped.wait();

      await this.clearBreakpoints(fileName);
      const normalizedFileName = this.getNormalizedFileName(fileName);
      const breakpointsConfirmed: Breakpoint[] = [];
      const breakpointIDs: number[] = [];

      // Send each breakpoint to GDB. As GDB replies with acknowledgements of
      // the breakpoint being set, if the breakpoint has been bound to a source
      // location, mark the breakpoint as being verified. Further, regardless
      // of whether or not a breakpoint has been bound to source, modify break
      // conditions if/when applicable. Note that since we issue commands sequentially
      // and the debugger will resolve commands in order, we fulfill the requirement
      // that breakpoints be returned in the same order requested
      try {
        await Promise.all(breakpoints.map(
          srcBreakpoint => this.sendCommand(getBreakpointInsertionCommand(normalizedFileName, srcBreakpoint))
          .then((breakpoint: OutputRecord) => {
            const bkpt = breakpoint.getResult('bkpt');
            if (bkpt) {
              breakpointsConfirmed.push(new Breakpoint(!bkpt.pending, bkpt.line));

              if (srcBreakpoint.logMessage)
                this.logBreakpoints[bkpt.number] = srcBreakpoint.logMessage;

              breakpointIDs.push(parseInt(bkpt.number));
          }
        })));
      } catch (e) {
        console.error(e);
      }

      // Only return breakpoints GDB has actually bound to a source. Others will be marked verified as the debugger binds them later on
      this.breakpoints[fileName] = breakpointIDs;
      // This is one of the few requests that may be hit prior to the inferior running. In such case, do not attempt to continue a process that has yet to be started
      if (!wasPaused && this.inferiorRunning)
        this.continue();

      return breakpointsConfirmed;
    });

    this.startupPromises.push(promise.then(() => {}));
    return promise;
  }

  public stepIn(threadID: number): Promise<OutputRecord> {
    return this.sendCommand(`-exec-step --thread ${threadID}`);
  }

  public stepOut(threadID: number): Promise<OutputRecord> {
    return this.sendCommand(`-exec-finish --thread ${threadID}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public stepBack(threadID: number): Promise<OutputRecord> {
    return this.sendCommand('reverse-step');
  }

  public terminate(): Promise<any> {
    // If we attached, free the ptrace
    if (this.attachPID) {
      this.sendCommand('detach');
    }

    return this.sendCommand('-gdb-exit');
  }

  public async createVariable(name: string): Promise<DebuggerVariable> {
    const gdbVariable = await this.sendCommand(`-var-create - * "${this.escapeQuotes(name)}"`);
    // Dyanmic GDB variables need also reference has_more to accurately determine if they are a composite/aggregate type
    const childCount =
      parseInt(gdbVariable.getResult('numchild')) ||
      parseInt(gdbVariable.getResult('dynamic')) ||
      parseInt(gdbVariable.getResult('has_more'));

    const variableValue = gdbVariable.getResult('value');
    const newReferenceID = this.variables.length + 1;
    const newVariable: DebuggerVariable = {
      name:             name,
      debuggerName:     gdbVariable.getResult('name'),
      numberOfChildren: childCount,
      referenceID:      childCount ? newReferenceID : 0,
      value:            variableValue,
      type: gdbVariable.getResult('type'),
    };

    this.variables[newReferenceID] = newVariable;
    return newVariable;
  }

  public goto(file: string, line: number): Promise<boolean> {
    return this.sendCommand(`-exec-jump ${file}:${line}`).then(() => true);
  }

  protected createDebuggerLaunchCommand(args: LaunchRequestArguments | AttachRequestArguments): string[] {
    // This idea is borrowed from the Microsoft cpptools VSCode extension.
    // It really is the only conceivable way to support running in the
    // integrated terminal. We spin on the GDB process to prevent the shell
    // from accepting normal commands. We set a trap handler to correctly
    // communicate inferior completion back to the debug adapter so we can
    // issue the corresponding TerminatedEvent and take down GDB. We issue
    // the +m command to hide the background "done" message when GDB
    // finishes debugging the inferior. These hacks probably won't work on Windows

    let out = [args.debugger || 'gdb', ...args.debuggerArgs || [], '--interpreter=mi', '--tty=`tty`', '-q'];

    // Append any user specified arguments to the inferior
    if (args.request === 'launch') {
      // Launch request
      if (args.args?.length) {
        out = [...out, '--args', args.program || '', ...args.args];
      } else {
        out.push(args.program);
      }
    }

    return out;
  }

  private async clearDebuggerVariables(): Promise<void> {
    await Promise.all(Object.values(this.variables).map(variable => this.sendCommand(`-var-delete ${variable.debuggerName}`)));
    this.variables = [];
  }

  private escapeQuotes(str: string): string {
    return str.replace(/"/g, '\\"');
  }

  private escapeEscapeCharacters(str: string): string {
    return str.replace(/\\/g, '');
  }

  private isPseudoVariableChild(child: any): boolean {
    return !child.type && !child.value;
  }

  private getNormalizedVariableID(id: number): number {
    if (id < SCOPE_LOCAL) {
      return id;
    } else {
      return id - SCOPE_LOCAL;
    }
  }

  private async clearFunctionBreakpoints(): Promise<void> {
    await Promise.all(Object.values(this.functionBreakpoints).map((num: number) => this.sendCommand(`-break-delete ${num}`)));
    this.functionBreakpoints = {};
  }

  private async clearExceptionBreakpoints(): Promise<void> {
    await Promise.all(Object.values(this.exceptionBreakpoints).map((num: number) => this.sendCommand(`-break-delete ${num}`)));
    this.exceptionBreakpoints = {};
  }

  private async printLogPoint(msg: string): Promise<string> {
    const vars = msg.match(/{.*?}/g);

    if (vars) {
      const pending: Promise<boolean>[] = [];

      vars.forEach(v => {
        const varName = v.replace('{', '').replace('}', '');

        pending.push(
          new Promise(resolve => {
            this.sendCommand(`-var-create - * "${varName}"`).then(
              async vObj => {
                this.sendCommand(
                  `-var-evaluate-expression ${vObj.getResult('name')}`
                ).then(vRes => {
                  msg = msg.replace(v, vRes.getResult('value'));
                  resolve(true);
                });
              }
            );
          })
        );
      });

      await Promise.all(pending);
    }
    return msg;
  }
}
