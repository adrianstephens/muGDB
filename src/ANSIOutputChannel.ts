import * as vscode from 'vscode';

function NegativeArray<T>() {
	const arrays = {
		pos: [] as T[],
		neg: [] as T[],
	};
	return new Proxy(arrays, {
		get: (arrays, index: string): T => {
			const i = +index;
			return i < 0 ? arrays.neg[-i] : arrays.pos[i];
		},
		set: (arrays, index: string, value: T) => {
			const i = +index;
			if (i < 0)
				arrays.neg[-i] = value;
			else
			arrays.pos[i] = value;
			return true;
		},
		has: (arrays, index: string) => {
			const i = +index;
			return i < 0 ? -i in arrays.neg : i in arrays.pos;
		},
		ownKeys: (arrays) => {
			const keys = [...Object.keys(arrays.neg).reverse().map(i => '-' + i), ...Object.keys(arrays.pos)];
			return keys;
			//return [...Object.keys(arrays.neg).reverse().map(i => '-' + i), ...Object.keys(arrays.pos)];
		},
		getOwnPropertyDescriptor: (arrays, index: string) => {
			return {writable: true, enumerable: true, configurable: true};
			const desc = index[0] === '-'
				? Object.getOwnPropertyDescriptor(arrays.neg, index.slice(1))
				: Object.getOwnPropertyDescriptor(arrays.pos, index);
			return desc;
			//return Object.getOwnPropertyDescriptor(index[0] === '-' ? arrays.neg : arrays.pos, index);
		},
	}) as unknown as T[];
}

export class ANSIOutputChannel implements vscode.OutputChannel {
	private inner: vscode.OutputChannel;
	private editor?: vscode.TextEditor;
	private backlog: string[] = [];
	private decorationTypes: Record<string, vscode.TextEditorDecorationType> = {};
	private currentLine = 0;
	private pendingEdit: Promise<void> = Promise.resolve();  // Chain for edits

	constructor(public name: string) {
		this.inner = vscode.window.createOutputChannel(name, 'plaintext');
		//this.inner.appendLine('Starting...');

		vscode.window.onDidChangeVisibleTextEditors(async editors => {
			if (!this.editor && (this.editor = editors.find(e => e.document.fileName.startsWith('extension-output-') && e.document.fileName.endsWith(this.name)))) {
				for (const line of this.backlog)
					this.colourise(line);
				this.backlog = [];
			}
		});
	}

	private colourise(value: string) {
		const ansiRegex = /(.*?)\u001b\[(\d+)m/g;
		let rawText = '';
		let lastIndex = 0;
		let match;

		const decorations: { start: number, end: number, decoration: vscode.TextEditorDecorationType }[] = [];
		while ((match = ansiRegex.exec(value))) {
			rawText += match[1];
			const offset = rawText.length;

			if (decorations.at(-1)?.end === 0)
				decorations.at(-1)!.end = offset;

			const code				= match[2];
			if (code !== '0'&& code !== '39') {
				const decoration	= (this.decorationTypes[code] ??= this.createDecorationForCode(code));
				decorations.push({ start: offset, end: 0, decoration });
			}
			lastIndex = ansiRegex.lastIndex;
		}

		rawText += value.substring(lastIndex);
		if (decorations.at(-1)?.end === 0)
			decorations.at(-1)!.end = rawText.length;

		this.inner.appendLine(rawText);
		return;

		this.pendingEdit = this.pendingEdit.then(() => {
			const document = this.editor!.document;
			const currentLine = document.lineCount;
//			const workspaceEdit = new vscode.WorkspaceEdit();
//			workspaceEdit.insert(document.uri, new vscode.Position(currentLine, 0), rawText + '\n');
//			vscode.workspace.applyEdit(workspaceEdit)
			this.editor!.edit(editBuilder => editBuilder.insert(new vscode.Position(currentLine, 0), rawText + '\n'), {
					undoStopBefore: false,
					undoStopAfter: false
			})
			.then(success => {
				console.log(`Edit operation ${success ? 'succeeded' : 'failed'}`);
				for (const d of decorations)
					this.editor!.setDecorations(d.decoration, [new vscode.Range(new vscode.Position(currentLine, d.start), new vscode.Position(currentLine, d.end))]);
			});
		});
	}

	private createDecorationForCode(code: string): vscode.TextEditorDecorationType {
			const decorationOptions: vscode.DecorationRenderOptions = {};
			switch (code) {
					case '30': decorationOptions.color = '#000000'; break; // Black
					case '31': decorationOptions.color = '#CD0000'; break; // Red
					case '32': decorationOptions.color = '#00CD00'; break; // Green
					case '33': decorationOptions.color = '#CDCD00'; break; // Yellow
					case '34': decorationOptions.color = '#0000EE'; break; // Blue
					case '35': decorationOptions.color = '#CD00CD'; break; // Magenta
					case '36': decorationOptions.color = '#00CDCD'; break; // Cyan
					case '37': decorationOptions.color = '#E5E5E5'; break; // White
					// Bright variants
					case '90': decorationOptions.color = '#7F7F7F'; break; // Bright Black
					case '91': decorationOptions.color = '#FF0000'; break; // Bright Red
					case '92': decorationOptions.color = '#00FF00'; break; // Bright Green
					case '93': decorationOptions.color = '#FFFF00'; break; // Bright Yellow
					case '94': decorationOptions.color = '#5C5CFF'; break; // Bright Blue
					case '95': decorationOptions.color = '#FF00FF'; break; // Bright Magenta
					case '96': decorationOptions.color = '#00FFFF'; break; // Bright Cyan
					case '97': decorationOptions.color = '#FFFFFF'; break; // Bright White
					// Bold
					case '1': decorationOptions.fontWeight = 'bold'; break;
					// Reset
					case '0': break; // Default color and weight
			}

			return vscode.window.createTextEditorDecorationType(decorationOptions);
	}

	append(value: string): void { this.inner.append(value); }

	appendLine(value: string): void {
		if (!this.editor) {
			this.backlog.push(value);
		} else {
			(async () => {
				this.colourise(value);
			})();
		}
	}

	replace(value: string): void	{ this.inner.replace(value); }
	clear():								void { this.inner.clear(); }
	show(preserveFocus?: boolean): void;
	show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
	show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
		if (typeof columnOrPreserveFocus === 'boolean') {
			this.inner.show(columnOrPreserveFocus);
		} else {
			this.inner.show(columnOrPreserveFocus, preserveFocus);
		}
	}
	hide() { this.inner.hide(); }

	dispose() {
		for (const decorationType of Object.values(this.decorationTypes))
				decorationType.dispose();
		this.inner.dispose();
	}

}
