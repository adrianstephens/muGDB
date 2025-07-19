import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {execSync} from 'child_process';
import {GDB} from './gdb/GDB';
import {getProcesses} from './processes';

class GDBConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
				config.type			= 'mugdb';
				config.name			= 'Launch';
				config.request		= 'launch';
			}
		}

		return config;
	}
}

// Get TTY device path from process ID
function getTTYFromPid(pid: number): string | undefined {
	switch (os.platform()) {
		case 'darwin': {
			const tty = execSync(`ps -p ${pid} -o tty=`).toString().trim();
			if (tty && tty !== '?')
				return `/dev/${tty}`;
			break;
		}
		case 'linux': {
			const tty = fs.readlinkSync(`/proc/${pid}/fd/0`);
			if (tty.startsWith('/dev/'))
				return tty;
			break;
		}
		case 'win32': {
			// Windows doesn't use TTY devices, return a named pipe path instead
			const pipeName = `\\\\.\\pipe\\mugdb-${pid}`;
			return pipeName;
		}
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('muGDB');
	const ttys: Record<string, {terminal: vscode.Terminal, dev: string}> = {};

	context.subscriptions.push(
		vscode.commands.registerCommand("mugdb.pickProcess", async (args: any) => {
			let processes = await getProcesses();
			if (args.program) {
				processes = processes.filter(process => path.basename(process.name) === args.program);
				if (processes.length === 0) {
					vscode.window.showErrorMessage(`No process found matching ${args.program}`);
					return;
				}
			}
			if (processes.length === 1)
				return processes[0].pid.toString();

			const selection = await vscode.window.showQuickPick(
				processes.map(process => ({label: path.basename(process.name), description: process.pid.toString(), detail: process.commandLine})),
				{canPickMany: false}
			);
			if (selection)
				return selection.description;
		}),
		vscode.commands.registerCommand("mugdb.getTTY", async (arg: any) => {
			const name = typeof arg === 'string' ? arg : 'mugdb';
			// If we already have a TTY path and the terminal is still active, return it
			if (ttys[name] && ttys[name].terminal.exitStatus === undefined)
				return ttys[name].dev;
			
			// Create a new terminal
			const terminal = vscode.window.createTerminal('muGDB TTY');
			terminal.show();
			
			// Get the process ID and find its TTY
			const processId = await terminal.processId;
			if (!processId) {
				vscode.window.showErrorMessage('Could not get terminal process ID');
				return undefined;
			}
			
			// Get the TTY from the process ID
			const dev = getTTYFromPid(processId);
			if (!dev) {
				vscode.window.showErrorMessage('Could not determine TTY device');
				return undefined;
			}
			
			ttys[name] = {terminal, dev};
			return dev;
		}),
		vscode.debug.registerDebugConfigurationProvider('mugdb', new GDBConfigurationProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory('mugdb', {
			createDebugAdapterDescriptor(session: vscode.DebugSession) {
				return new vscode.DebugAdapterInlineImplementation(new GDB(outputChannel, session.configuration));
			}
		})
	);
}

export function deactivate() {}