# muGDB | Yet another Visual Studio Code GDB Debug Adapter

A minimalist native typescript implementation of a debug adapter for GDB for use in Visual Studio Code

## Why?

Have you ever been able to run gdb manually but couldn't get any of the existing vscode GDB extensions to work (well)?

- This extension lets you be explicit about how to launch gdb, and what commands it should run.

- There's only one request option, 'launch', and here it means 'launch gdb'. The debugee can be passed in 'debuggerArgs' or via a 'file' command.

- GDB can be run remotely through netcat or ssh; this is separate from GDB's own ability to debug remotely.

- You can connect to an already-running gdb process by providing a host name and port number, or via a process ID.

## Features

- Command completion
- Support for Source, Function, Instruction, and Data breakpoints
- All breakpoint types support conditions and hit counts
- Disassembly viewing and stepping
- Reverse debugging (where supported on GDB)
- Registers shown as a hierarchy based on GDB register groups
- Globals are shown in their own scope
- Statics are shown in an extra scope when present
- Debug Console prompt accepts native GDB commands (as well as MI commands), and MI results are formatted for readability
- `python-interactive` is simulated though use of the `python` command
- Fast - DAP commands are sent directly to gdb without the usual extra serialization

## Configuration

These are all of the settings currently supported:

### Launch Requests

| Configuration Option  | Required | Description                                                              |
| --------------------- |----------|--------------------------------------------------------------------------|
| `request`             | Yes      | Set this to `launch`                                                     |
| `debugger`            | No       | Path to GDB executable<br>```"/absolute/path/to/gdb"```                  |
| `debuggerArgs`        | No       | Array of arguments to pass to debugger<br>```["arg", ...]``` |
| `cwd`                 | No       | The directory in which to start GDB<br>```"someOptionalDirectory"```     |
| `env`                 | No       | Key value pairs of environment variables to set in debugging shell<br>```{"name": "value", ...}``` |
| `capabilities`        | No       | Key value pairs of values to override the DAP capabilites returned on initialize<br>```{"name": value, ...}``` |
| `logging`             | No       | Verbosity of logging.<br>```"off"\|"basic"\|"verbose"```                 |
| `startupCmds`         | No       | Array of GDB commands to run at start (after .gdbinit)<br>```["command", ...]``` |
| `postLoadCmds`        | No       | Array of GDB commands to run after program is loaded<br>```["command", ...]``` |
| `terminateCmds`       | No       | Array of GDB commands to run at end<br>```["command", ...]``` |
| `sourceMapping`       | No       | Mapping of gdb source paths to actual paths where files are found<br>```{"path": "path", ...]``` |

`command` can be a native GDB command or an MI command

#### Additional Notes
