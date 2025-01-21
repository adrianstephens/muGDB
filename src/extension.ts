import * as vscode from 'vscode';
import * as path from 'path';
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
/*
export class DisassemblyProvider implements vscode.TextDocumentContentProvider {
	static SCHEME = 'disassembly-source';

	async provideTextDocumentContent(uri: vscode.Uri) {
		const parts		= uri.path.split('/');
		const memoryReference = parts[1].split('.')[0];
		const session	= vscode.debug.activeDebugSession;
		if (session) {
			const resp = await session.customRequest('disassemble', {memoryReference});
			return resp.instructions.map((i: any) =>
				`${i.address.toString(16).padStart(8, '0')}: ${i.instruction}`
			).join('\n');
		}
		return '';
	}
}
*/

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('muGDB');

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
		//vscode.workspace.registerTextDocumentContentProvider(DisassemblyProvider.SCHEME, new DisassemblyProvider),
		vscode.debug.registerDebugConfigurationProvider('mugdb', new GDBConfigurationProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory('mugdb', {
			createDebugAdapterDescriptor(session: vscode.DebugSession) {
				return new vscode.DebugAdapterInlineImplementation(new GDB(outputChannel, session.configuration));
			}

		})
	);
}

export function deactivate() {}
