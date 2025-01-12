import * as vscode from 'vscode';
import {GDB} from './gdb/GDB';

class GDBConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
				config.type = 'mugdb';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = 'a.out';
				config.stopOnEntry = true;
			}
		}

		return config;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('muGDB');

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('mugdb', new GDBConfigurationProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory('mugdb', {
			createDebugAdapterDescriptor(session: vscode.DebugSession) {
				return new vscode.DebugAdapterInlineImplementation(new GDB(outputChannel, session.configuration));
			}

		})
	);
}

export function deactivate() {}
