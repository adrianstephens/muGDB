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

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('muGDB');

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DisassemblyProvider.SCHEME, new DisassemblyProvider),
		vscode.debug.registerDebugConfigurationProvider('mugdb', new GDBConfigurationProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory('mugdb', {
			createDebugAdapterDescriptor(session: vscode.DebugSession) {
				return new vscode.DebugAdapterInlineImplementation(new GDB(outputChannel, session.configuration));
			}

		})
	);
}

export function deactivate() {}
