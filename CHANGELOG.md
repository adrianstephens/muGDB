# Changelog

All notable changes to the "muGDB" extension will be documented in this file.

## [0.2.0] - Current

### Features
- Command completion
- Support for Source, Function, Instruction, and Data breakpoints
- All breakpoint types support conditions, hit counts, and logging
- Disassembly viewing and stepping
- Reverse debugging (where supported on GDB)
- Registers shown as a hierarchy based on GDB register groups
- Globals are shown in their own scope
- Statics are shown in an extra scope when present
- Debug Console prompt accepts native GDB commands and MI commands
- MI results are formatted for readability
- `python-interactive` simulation through the `python` command
- Fast DAP command processing

### Configuration Options
- Support for remote GDB connections via netcat or ssh
- Connect to already-running GDB processes via host:port or process ID
- Customizable startup, post-load, and termination commands
- Source path mapping
- Environment variable configuration

## [0.1.0] - Initial Release

### Features
- Basic GDB integration with Visual Studio Code
- Support for launching GDB with custom arguments
- Initial implementation of debug adapter for GDB