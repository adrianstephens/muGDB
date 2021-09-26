import {MIParser, STOPPED, RUNNING, ERROR} from './parser/MIParser';
import {EventEmitter} from 'events';
import {OutputRecord} from './parser/OutputRecord';
import {AsyncRecord, AsyncRecordType} from './parser/AsyncRecord';
import {ResultRecord} from './parser/ResultRecord';
import {StreamRecord} from './parser/StreamRecord';
import {Breakpoint, Thread, StackFrame, Source, CompletionItem} from 'vscode-debugadapter';
import {OutputChannel, Terminal} from 'vscode';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as ts from 'tail-stream';
import {spawn} from 'child_process';
import {
  AttachRequestArguments,
  LaunchRequestArguments,
  DebugLoggingLevel,
} from '../../DebugSession';
import path = require('path');

// GDB stop reasons
export const EVENT_OUTPUT = 'output';
export const EVENT_RUNNING = 'running';
export const EVENT_BREAKPOINT_HIT = 'breakpoint-hit';
export const EVENT_END_STEPPING_RANGE = 'end-stepping-range';
export const EVENT_FUNCTION_FINISHED = 'function-finished';
export const EVENT_EXITED_NORMALLY = 'exited-normally';
export const EVENT_SIGNAL = 'signal-received';
export const EVENT_PAUSED = 'paused';
export const EVENT_ERROR = 'error';
export const EVENT_ERROR_FATAL = 'error-fatal';
export const EVENT_THREAD_NEW = 'thread-created';
export const EVENT_SOLIB_LOADED = 'library-loaded';
export const EVENT_SOLIB_ADD = 'solib-event';

export const SCOPE_LOCAL = 1000;
export const SCOPE_REGISTERS = 2000;

// Used as an abstraction for integrated/non-integrated terminals
abstract class TerminalWindow {
  public abstract sendCommand(cmd: string): void;
  public abstract destroy(): void;
  protected terminal: any;
}

class IntegratedTerminal extends TerminalWindow {
  constructor(cmd: string, terminal: Terminal) {
    super();
    this.terminal = terminal;
    this.sendCommand('clear');
    this.sendCommand(cmd);
    this.terminal.show(true);
  }

  public sendCommand(cmd: string) {
    this.terminal.sendText(cmd);
  }

  public destroy() {
    // Nothing needs to be done for integrated terminal
  }
}
class ExternalTerminal extends TerminalWindow {
  constructor(cmd: string) {
    super();
    this.terminal = spawn('x-terminal-emulator', ['-e', cmd]);
    this.terminal.on('error', () => {
      console.log('Failed to open external terminal');
    });
  }

  public sendCommand(cmd: string) {
    this.terminal.stdin.write(`${cmd}\n`);
  }

  public destroy() {
    // Close terminal if not done already
    this.terminal.kill();
  }
}

// Used to represent any signal thrown from GDB, including SIGSEGV, SIGINT, etc.
class GDBException {
  name: string;
  location: string;

  constructor(record: OutputRecord) {
    const frame = record.getResult('frame');
    this.name = `${record.getResult('signal-meaning')} (${record.getResult('signal-name')})`,
    this.location = `${frame.addr} in ${frame.func} at ${frame.file}:${frame.line}`
  }
}

class GDBVariable {
  // Source-code variable name
  name: string;

  // Number of immediate children
  numberOfChildren: number;

  // Name used by GDB for variable tracking
  GDBName: string;

  // Short hand representation for non-aggregate types
  value: string;

  constructor(record: any) {
    this.name = record.exp;
    this.numberOfChildren = parseInt(record.numchild);
    this.GDBName = record.name;
    this.value = record.value || '';
  }
}

export class GDB extends EventEmitter {
  // Default path to MI debugger. If none is specified in the launch config
  // we will fallback to this path
  private path = 'gdb';

  // Arguments to pass to GDB. These will be combined with any that need to
  // be threaded to the inferior process
  private args: string[] = ['--interpreter=mi', '-q', '--tty=`tty`'];

  // This instance will handle all MI output parsing
  private parser: MIParser;

  // Used to sync MI inputs and outputs. Value increases by 1 with each
  // command issued
  private token: number;

  // Callbacks to execute when a command identified by "token" is resolved
  // by the debugger
  private handlers: {[token: number]: (record: OutputRecord) => any};

  // The current thread on which the debugger is stopped on. If the debugger
  // is not currently stopped on any thread, this value is -1. Also serves
  // as a stopped sentinel
  private threadID: number;

  private outputChannel: OutputChannel;
  private terminal?: TerminalWindow;

  // Control whether or not to dump extension diagnostic information to a
  // dedicated output channel (useful for development)
  private debug: DebugLoggingLevel = DebugLoggingLevel.OFF;

  // Filepaths to input and output pipes used for IPC with GDB process. These
  // will be randomly generated on each debug session
  private inputFile = '';
  private outputFile = '';

  // IO handles to actual pipes. The input handle is an actual FIFO handle
  // while the output handle is a normal fd
  private inputHandle: any;
  private outputHandle: any;

  // Output buffering for stdout pipe
  private ob: string;

  // Inferior PID for attach requests
  public PID = 0;

  // Should we emit a stopped event on a pause?
  private handleSIGINT = true;

  // Should we only load certain libraries?
  private sharedLibraries: string[] = [];

  // Should we use absolute file paths when setting breakpoints?
  private useAbsoluteFilePaths = true;

  // Mapping of register numbers to their names
  private registers: string[] = [];

  // Mapping of symbolic variable names to GDB variable references
  private variables = new Map<number, GDBVariable>();

  private variableReferenceID = 0;

  // Breakpoint mappings
  private breakpoints = new Map();

  private loadedLibraries = new Map();

  private cwd: string = '';

  private lastException: GDBException;

  public constructor(outputChannel: OutputChannel) {
    super();

    this.outputChannel = outputChannel;
    this.token = 0;
    this.threadID = 0;
    this.ob = '';
    this.handlers = [];
    this.parser = new MIParser();

    // This is a bit of a hack -- since there is no elegant way of making a
    // FIFO pipe in nodeJS we need to resort to a shell to do so. We need to
    // do this in the constructor to give sufficient time for the FIFO pipe
    // creation prior to writing to it
    this.createIOPipes();
  }

  private createIOPipes() {
    this.inputFile = this.generateTmpFile('In') + this.token;
    this.outputFile = this.generateTmpFile('Out') + this.token;
    const cmd = `mkfifo ${this.inputFile} ;`;
    const {exec} = require('child_process');
    exec(cmd);
  }

  private log(text: string) {
    if (this.debug !== DebugLoggingLevel.OFF) {
      this.outputChannel.appendLine(text);
    }
  }

  private genRandomID(length: number): string {
    let result = '';
    const characters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  private generateTmpFile(desc: string): string {
    return `/tmp/vGDB_${desc}${this.genRandomID(8)}`;
  }

  private createLaunchCommand(): string {
    // This idea is borrowed from the Microsoft cpptools VSCode extension.
    // It really is the only conceivable way to support running in the
    // integrated terminal. We spin on the GDB process to prevent the shell
    // from accepting normal commands. We set a trap handler to correctly
    // communicate inferior completion back to the debug adapter so we can
    // issue the corresponding TerminatedEvent and take down GDB. We issue
    // the +m command to hide the background "done" message when GDB
    // finishes debugging the inferior
    // All of these hacks probably won't work on Windows
    fs.writeFile(this.outputFile, '', () => {});

    // We cannot simply send all commands to the terminal and assume the
    // user's default shell is bash. Instead we will wrap all cmds in a
    // string and explicitly invoke the bash shell
    return `trap '' 2 ; ${this.path} ${this.args.join(' ')} < ${
      this.inputFile
    } > ${
      this.outputFile
    } & clear ; pid=$!; set +m ; wait $pid ; trap 2 ; echo ;`;
  }

  public setDebug(debug: DebugLoggingLevel) {
    this.debug = debug;
  }

  public setCWD(cwd: string) {
    this.cwd = cwd;
  }

  private isLaunch(arg: any): arg is LaunchRequestArguments {
    return arg && typeof arg.program === 'string';
  }

  public spawn(
    args: LaunchRequestArguments | AttachRequestArguments,
    terminal: Terminal
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let envVarsSetupCmd = '';
      // Spawn the GDB process in the integrated terminal. In order to
      // correctly separate inferior output from GDB output and pipe
      // them to the correct handlers we use some hacks:
      // (1) We set the inferior-tty to be that of the integrated terminal
      //     This lets us pipe all stdout/stderr from the inferior there
      //     and separate it from any output created by GDB. It also lets
      //     us use the integrated terminal for the inferior's input
      // (2) We redirect all GDB stdout to a tmp file which the debug
      //     adapter will monitor for command results and other async
      //     notify events
      // (3) We redirect all stdin to GDB through another FIFO pipe which
      //     we will keep open throughout the entirety of the debug
      //     session (to prevent premature debugger exit).
      if (args.debugger) {
        this.path = args.debugger;
      }

      // (Advanced) if user has specified filenames only be used for
      // setting breakpoints, set the appropriate flag
      if (args.useAbsoluteFilePaths !== undefined) {
        this.useAbsoluteFilePaths = args.useAbsoluteFilePaths;
      }

      // If this is an attach request, the program arg will be a numeric
      // We need to thread this differently to GDB
      if (this.isLaunch(args)) {
        if (args.args) {
          this.args.push('--args');
          this.args.push(args.program);
          this.args = this.args.concat(args.args);
        } else {
          this.args.push(args.program);
        }

        if (args.envVars) {
          envVarsSetupCmd = this.createEnvVarsCmd(args.envVars);
        }
      } else {
        this.PID = args.program;
      }

      const launchCmd = this.createLaunchCommand();
      this.log(launchCmd);

      // If the launch has requested an external terminal, spawn one. If so,
      // we will not clear the old terminal. We only clear the integrated
      // terminal if we will be reusing it
      if (args.externalConsole !== undefined && args.externalConsole) {
        this.terminal = new ExternalTerminal(`${envVarsSetupCmd}bash -c "${launchCmd}"`);
      } else {
        this.terminal = new IntegratedTerminal(
          `${envVarsSetupCmd}bash -c "${launchCmd}"`,
          terminal
        );
      }

      this.inputHandle = fs.createWriteStream(this.inputFile, {flags: 'a'});
      this.outputHandle = ts.createReadStream(this.outputFile);

      this.outputHandle.on('data', (data: any) => {
        this.stdoutHandler(data);
      });

      // Only consider GDB as ready once pipe is ready. Once ready send all setup
      // cmds to GDB and then resolve promise
      this.inputHandle.on('open', () => {
        const cmdsPending: Promise<any>[] = [];

        this.cacheRegisterNames();

        if (this.isLaunch(args) && args.startupCmds) {
          args.startupCmds.forEach(cmd => {
            cmdsPending.push(this.sendCommand(cmd));
          });
        }

        Promise.all(cmdsPending).then(brkpoints => {
          resolve(true);
        });
      });
    });
  }

  // Send an MI command to GDB
  public sendCommand(cmd: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.log(cmd);
      this.inputHandle.write(`${(++this.token) + cmd}\n`);
      this.handlers[this.token] = (record: OutputRecord) => {
        this.log(record.prettyPrint());
        resolve(record);
      };
    });
  }

  public deferLibraryLoading(libraries: string[]): Promise<any> {
    this.sharedLibraries = libraries;
    this.sendCommand('-gdb-set stop-on-solib-events 1');
    return this.sendCommand('-gdb-set auto-solib-add off');
  }

  public sanitize(text: string, MI: boolean): string {
    text = (text || '')
      .replace(/&"/g, '')
      .replace(/\\n/g, '')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\v/g, '\v')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');

    // If we are sanitizing MI output there are additional things we need
    // to strip out
    if (MI) {
      text = text.replace(/^~"[0-9]*/g, '').replace(/"$/g, '');
    }

    return text;
  }

  private createEnvVarsCmd(envVars: object): string {
    let cmd = '';

    Object.keys(envVars).forEach((key: string) => {
      cmd = `export ${key}=${envVars[key]}; ${cmd}`;
    });

    return cmd;
  }

  // Called on any stdout produced by GDB Process
  private stdoutHandler(data: any) {
    let record: OutputRecord | null;
    const str = data.toString('utf8');
    this.ob += str;

    // We may be receiving buffered output. In such case defer parsing until
    // full output has been transmitted as denoted by a trailing newline
    const nPos = this.ob.lastIndexOf('\n');
    if (nPos !== -1) {
      // If multiple lines have buffered, handle each one
      const lines = this.ob.substr(0, nPos).split('\n') as string[];

      // Flush output buffer for next round of output
      this.ob = this.ob.substring(nPos + 1);

      lines.forEach(line => {
        try {
          if ((record = this.parser.parse(line))) {
            this.handleParsedResult(record);

            // Minimize the amount of logging
            if (
              record.constructor === StreamRecord ||
              this.debug === DebugLoggingLevel.VERBOSE
            ) {
              this.emit(
                EVENT_OUTPUT,
                this.sanitize(record.prettyPrint(), true)
              );
            }
          }
        } catch (error: any) {
          this.log(error.stack);
          this.emit(EVENT_ERROR_FATAL);
        }
      });
    }
  }

  private handleParsedResult(record: OutputRecord) {
    switch (record.constructor) {
      case AsyncRecord:
        // Notify GDB client of status change
        switch (record.getType()) {
          case AsyncRecordType.EXEC:
            switch (record.getClass()) {
              case STOPPED: {
                this.threadID = parseInt(record.getResult('thread-id'));
                const reason = record.getResult('reason');

                // Play nice with attach requests
                if (reason !== undefined) {
                  switch (reason) {
                    case EVENT_BREAKPOINT_HIT:
                      this.emit(reason, this.threadID);
                      break;

                    case EVENT_END_STEPPING_RANGE:
                      this.emit(reason, this.threadID);
                      break;

                    case EVENT_FUNCTION_FINISHED:
                      this.emit(EVENT_FUNCTION_FINISHED, this.threadID);
                      break;

                    case EVENT_EXITED_NORMALLY:
                      // Kill debugger
                      this.sendCommand('quit');
                      this.emit(reason);
                      break;

                    case EVENT_SIGNAL:
                      if (this.handleSIGINT) {
                        this.lastException = new GDBException(record);
                        this.emit(reason, this.threadID);
                      } else {
                        // Reset for next signal since commands are honored in sync
                        this.handleSIGINT = true;
                      }
                      break;

                    case EVENT_SOLIB_ADD:
                        this.sharedLibraries.forEach((library: string) => {
                          if (this.loadedLibraries.get(library)) {
                            this.sendCommand(`sharedlibrary ${library}`);
                          }
                        });

                        this.continue();
                      break;

                    default:
                      throw new Error('unknown stop reason: ' + reason);
                  }
                }
                break;
              }

              case RUNNING: {
                let tid: number, all: boolean;
                this.threadID = -1;
                all = false;

                this.clearVariables();

                this.clearVariables().then(() => {
                  // If threadID is not a number, this means all threads have continued
                  tid = parseInt(record.getResult('thread-id'));
                  if (isNaN(tid)) {
                    tid = this.threadID;
                    all = true;
                  }

                  // For now we assume all threads resume execution
                  this.emit(EVENT_RUNNING, this.threadID, all);
                });
                break;
              }
            }
            break;

          case AsyncRecordType.NOTIFY:
            // Listen for thread events
            if (record.getClass() === EVENT_THREAD_NEW) {
              this.emit(EVENT_THREAD_NEW, record.getResult('id'));
            } else if (
              this.sharedLibraries.length &&
              record.getClass() === EVENT_SOLIB_LOADED
            ) {
              // If deferred symbol loading is enabled, check that
              // the shared library loaded is in the user specified
              // whitelist. If not, unload it
              const libLoaded = path.basename(record.getResult('id'));
              if (this.sharedLibraries.indexOf(libLoaded) > -1) {
                this.loadedLibraries.set(libLoaded, true);
              }
            }
            break;

          case AsyncRecordType.STATUS:
            break;
        }
        break;

      case ResultRecord:
        // Fulfill promise on stack
        if (!isNaN(record.getToken())) {
          const handler = this.handlers[record.getToken()];

          if (handler) {
            handler(record);
            delete this.handlers[record.getToken()];
          } else {
            // There could be instances where we should fire DAP
            // events even if the request did not originally contain
            // a handler. For example, up/down should correctly move
            // the active stack frame in VSCode
          }
        }
        break;

      case StreamRecord:
        // Forward raw GDB output to debug console
        break;
    }
  }

  public clearBreakpoints(file: string | undefined): Promise<any> {
    if (file) {
      return new Promise((resolve, reject) => {
        const pending: Promise<any>[] = [];

        if (this.breakpoints.has(file)) {
          this.breakpoints.get(file).forEach((bp: any) => {
            pending.push(this.sendCommand(`-break-delete ${bp}`));
          });

          Promise.all(pending).then(brkpoints => {
            this.breakpoints.delete(file);
            resolve(true);
          });
        } else {
          resolve(true);
        }
      });
    } else {
      return this.sendCommand('-break-delete');
    }
  }

  public setBreakpoints(
    sourceFile: string,
    bps: any[] | null
  ): Promise<Breakpoint[]> {
    return new Promise((resolve, reject) => {
      const bpsPending: Promise<any>[] = [];
      const bpsVerified: Breakpoint[] = [];

      if (bps) {
        this.breakpoints.set(sourceFile, []);

        bps.forEach((bp: any) => {
          let file = sourceFile;

          if (!this.useAbsoluteFilePaths) {
            file = file.replace(this.cwd, '').replace(/^\//, '');
          }

          const promise = this.sendCommand(`-break-insert -f ${file}:${bp.line}`);
          bpsPending.push(promise);
          promise.then((record: ResultRecord) => {
            // If this is a conditional breakpoint we must relay the
            // expression to GDB and update the breakpoint
            const bpInfo = record.getResult('bkpt');

            this.breakpoints.get(sourceFile).push(bpInfo.number);

            if (bp.condition) {
              this.sendCommand(`-break-condition ${bpInfo.number} ${bp.condition}`).then((record: ResultRecord) => {
                bpsVerified.push(new Breakpoint(true, bpInfo.line));
              });
            } else {
              bpsVerified.push(new Breakpoint(true, bpInfo.line));
            }
          });
        });

        Promise.all(bpsPending).then(brkpoints => {
          resolve(bpsVerified);
        });
      } else {
        // No breakpoints to verify
        resolve([]);
      }
    });
  }

  public startInferior(): Promise<any> {
    // Launch the debuggee target -- we need to do some magic here to hide
    // the longstanding GDB bug when redirecting inferior output to a
    // different tty. So we clear the active terminal and continue on our
    // merry way.
    return new Promise((resolve, reject) => {
      this.sendCommand('-gdb-set target-async on').then(() => {
        return this.sendCommand('-exec-run').then(() => {
          vscode.commands
            .executeCommand('workbench.action.terminal.clear')
            .then(() => {
              resolve(true);
            });
        });
      });
    });
  }

  public attachInferior(): Promise<any> {
    // Only for attach requests
    return new Promise((resolve, reject) => {
      this.sendCommand('-gdb-set target-async on').then(() => {
        this.sendCommand(`attach ${this.PID}`).then(() => {
          return this.sendCommand('-exec-continue').then(() => {
            resolve(true);
          });
        });
      });
    });
  }

  public evaluateExpr(expr: string, frameID?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let cmd = '-data-evaluate-expression';

      if (frameID) {
        // "normalize" frameID with threadID
        frameID = frameID - this.threadID + 1;
        cmd += ` --frame ${frameID} --thread ${this.threadID}`;
      }

      cmd += ` "${expr}"`;

      this.sendCommand(cmd).then((record: ResultRecord) => {
        const r = record.getResult('value');

        if (r) {
          resolve(this.sanitize(r, false));
        } else {
          resolve(null);
        }
      });
    });
  }

  // This is a little different than the evaluate expr fcn as the expr to be
  // evaluated may be composed of various calls and other gdb commands, so
  // we pipe it as if the user would have typed it at the CL
  public execUserCmd(expr: string, frameID?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let cmd = '-interpreter-exec';

      if (frameID) {
        // "normalize" frameID with threadID
        frameID = frameID - this.threadID + 1;
        cmd += ` --frame ${frameID} --thread ${this.threadID}`;
      }

      // Escape any quotes in user input
      cmd += ` console "${expr.replace(/"/g, '\\"')}"`;

      this.sendCommand(cmd).then((record: ResultRecord) => {
        // If an error has resulted, also send an error event to show it to the user
        if (record.getClass() === ERROR) {
          this.emit(EVENT_ERROR, record.getResult('msg').replace(/\\/g, ''));
        }

        // TODO: if this was a stack navigation command, update the callstack
        // with the correct newly selected stackframe. Currently, the debug
        // adapter protocol does not support such behavior. See:
        // https://github.com/microsoft/debug-adapter-protocol/issues/118
        resolve(record.getResult('value'));
      });
    });
  }

  public getThreads(): Promise<any> {
    return new Promise((resolve, reject) => {
        this.sendCommand('-thread-info').then((record: ResultRecord) => {
          const threadsResult: Thread[] = [];
          record.getResult('threads').forEach(thread => {
            threadsResult.push(new Thread(parseInt(thread.id), thread.name));
          });

          resolve(threadsResult);
        });
    });
  }

  public isStopped(): boolean {
    return this.threadID !== -1;
  }

  public getStack(threadID: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.sendCommand(`-stack-list-frames --thread ${threadID}`).then(
        (record: ResultRecord) => {
          const stackFinal: DebugProtocol.StackFrame[] = [];
          record.getResult('stack').forEach((frame: any) => {
            frame = frame[1];

            let sf:DebugProtocol.StackFrame = new StackFrame(
              threadID + parseInt(frame.level),
              frame.func,
              new Source(frame.file, frame.fullname),
              parseInt(frame.line)
            );

            sf.instructionPointerReference = frame.addr;
            stackFinal.push(sf);
          });

          resolve(stackFinal);
        }
      );
    });
  }

  private isPseudoVariableChild(child: any): boolean {
    return !child.type && !child.value;
  }

  private getVariableChildren(GDBVariableName: string): Promise<any> {
    // Variable expanded, fetch GDB children
    // TODO: hard coding scopes to start at 1000 is not good for scalability -- rethink this
    // TODO: clean this up
    return new Promise((resolve, reject) => {
      this.sendCommand(`-var-list-children --simple-values "${GDBVariableName}"`).then((children) => {
        let childrenTemp = new Map();

        const c = children.getResult('children');
        const pending: Promise<any>[] = [];

        if (c) {
          for (let index = 0; index < c.length; index++) {
            const child = c[index];
            // Check to see if this is a pseudo child on an aggregate type
            // such as private, public, protected, etc. If so, traverse into
            // child and annotate its consituents with such attribute for
            // special treating by the front-end. Note we could have mulitple
            // such pseudo-levels at a given level
            if (this.isPseudoVariableChild(child[1])) {
              const p = this.getVariableChildren(child[1].name);
              pending.push(p);
              p.then(vars => {
                childrenTemp = new Map([...childrenTemp, ...vars]);
              });
            } else {  
              const childVar = new GDBVariable(child[1]);

              // TODO: clean this up
              childrenTemp.set(++this.variableReferenceID, childVar);
              this.variables.set(this.variableReferenceID, childVar);
            }
          }
        }

        Promise.all(pending).then(() => {
          resolve(childrenTemp);
        });
      });
    });
  }

  public getVars(reference: number, fetchLocal: boolean): Promise<any> {
    // This can be called in 1 of 2 contexts -- when we switch from a running
    // state to a paused state (by way of a breakpoint, interrupt or exception),
    // or after a REPL command is evaluated in the debug console. If the latter,
    // we simply solicit an update from GDB for variables already being tracked.
    return new Promise((resolve, reject) => {
      if (reference < SCOPE_LOCAL) {
        const gdbVar = this.variables.get(reference);

        if (gdbVar) {
          this.getVariableChildren(gdbVar.GDBName).then(vars => resolve(vars));
        } else {
          resolve([]);
        }
      } else if (fetchLocal) {
        // TODO: refactor this -- we do not need to refetch everything
        if (this.variables) {
          this.clearVariables();
        }

        this.sendCommand(
          `-stack-list-variables --thread ${this.threadID} --frame ${
            reference - SCOPE_LOCAL - this.threadID
          } --no-frame-filters --simple-values`
        ).then((record: OutputRecord) => {
          const pending: Promise<any>[] = [];

          // Ask GDB to create a new variable so we can correctly display nested
          // variables via reference IDs. When execution is resumed, delete all
          // temporarily created variables to avoid polluting future breaks
          record.getResult('variables').forEach(variable => {
            // TODO: single source with other branch
            pending.push(this.sendCommand(`-var-create - * "${variable.name}"`).then(gdbVariable => {
              this.variables.set(++this.variableReferenceID, {
                name: variable.name,
                numberOfChildren: parseInt(gdbVariable.getResult('numchild')),
                GDBName: gdbVariable.getResult('name'),
                value: gdbVariable.getResult('value')
              });
            }));
          });

          Promise.all(pending).then(() => {
            // Resolve outer promise once all prior promises have completed
            resolve(this.variables);
          });
        });
      } else {
        this.sendCommand(`-data-list-register-values r`).then((record: OutputRecord) => {
          resolve(record.getResult('register-values').map(reg => {
            return {
              name: this.registers[reg.number],
              value: reg.value
            }
          }).filter(reg => reg.name));
        });
      }
    });
  }

  public next(threadID: number, granularity: string): Promise<any> {
    if (granularity === 'instruction') {
      return this.sendCommand(`-exec-next-instruction --thread ${threadID}`);
    } else {
      // Treat a line as being synonymous with a statement
      return this.sendCommand(`-exec-next --thread ${threadID}`);
    }
  }

  public continue(threadID?: number): Promise<any> {
    if (threadID) {
      return this.sendCommand(`-exec-continue --thread ${threadID}`);
    } else {
      return this.sendCommand('-exec-continue');
    }
  }

  public stepIn(threadID: number): Promise<any> {
    return this.sendCommand(`-exec-step --thread ${threadID}`);
  }

  public stepOut(threadID: number): Promise<any> {
    return this.sendCommand(`-exec-finish --thread ${threadID}`);
  }

  // If catchSignal is false, we will not emit a stopped event. This is a
  // workaround for automatically pausing the debugger for user executed
  // commands while the inferior is running
  public pause(threadID?: number, catchSignal?: boolean): Promise<any> {
    if (catchSignal !== undefined && !catchSignal) {
      this.handleSIGINT = false;
    }

    return new Promise((resolve, reject) => {
      const wasPaused = this.isStopped();

      if (wasPaused) {
        resolve(wasPaused);
      } else {
        this.sendCommand(`-exec-interrupt ${threadID || ''}`).then(() => {
          resolve(wasPaused);
        });
      }
    });

  }

  public quit(attach: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      if (attach) {
        this.sendCommand('detach');
      }

      this.dispose();
      return this.sendCommand('-gdb-exit');
    });
  }

  public updateVar(variable: string, val: string): Promise<any> {
    return this.sendCommand(`set var ${variable} = ${val}`);
  }

  public commandCompletions(text: string, start: number): Promise<CompletionItem[]> {
    return new Promise((resolve, reject) => {
      this.sendCommand(`-complete "${text}"`).then((record: OutputRecord) => {
        let items:CompletionItem[] = [];
        record.getResult('matches').forEach((match: string) => {
          items.push(new CompletionItem(match, start));
        });

        resolve(items);
      });
    });
  }

  public disassemble(address: string): Promise<DebugProtocol.DisassembledInstruction[]> {
    return new Promise((resolve, reject) => {
      this.sendCommand(`-data-disassemble -a ${address} -- 0`).then((record: OutputRecord) => {
        const insts = record.getResult('asm_insns');
        let dasm: DebugProtocol.DisassembledInstruction[] = [];

        insts.forEach(inst => {
          const instDasm: DebugProtocol.DisassembledInstruction = {
            address: inst.address,
            instruction: inst.inst
          };

          dasm.push(instDasm);
        });
        resolve(dasm);
      });
    });
  }

  private cacheRegisterNames(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.sendCommand('-data-list-register-names').then((record: OutputRecord) => {
        record.getResult('register-names').forEach((reg: string, idx: number) => {
          this.registers[idx] = reg;
        });

        resolve(true);
      });
    });
  }

  private clearVariables(): Promise<void> {
    this.variables = new Map();
    this.variableReferenceID = 0;

    return this.sendCommand('-var-delete');
  }

  public dispose() {
    if (this.terminal) {
      this.terminal.destroy();
    }
  }

  public getLastException(): GDBException {
    return this.lastException;
  }
}