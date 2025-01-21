import * as os from 'os';
import * as fs from 'fs';
import {spawn} from 'child_process';

export class Process {
	constructor(public name: string, public pid: number, public ppid: number, public commandLine?: string) { }
}

function run(command: string, args: string[], callback: (data: string)=>void): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const process = spawn(command, args);

		if (process) {
			process.stdout.setEncoding('utf8');

			process.stdout.on('data', data => callback(data.toString()));
			process.on('error', error => reject(error));
			process.on('close', code => {
				if (code)
					reject(new Error('error'));
				else
					resolve();
			});
		}
	});
}

export async function getProcesses() : Promise<Process[]> {
	let promise: Promise<any>;
	const processes: Process[] = [];

	let remaining = "";
	function lines(data: string) {
		const lines = (remaining + data).split(os.EOL);
		remaining = lines.pop()!;
		return lines;
	}

	switch (os.platform()) {
		case 'win32': {
			promise = run('pwsh', ['Get-CimInstance Win32_Process | Select-Object Name,ProcessId,CommandLine | ConvertTo-JSON -Compress'], data => {
				JSON.parse(data).forEach((process: any) => {
					processes.push(new Process(process.Name, process.ProcessId, process.ParentProcessId, process.CommandLine));
				});
			});
			break;
		}
		case 'darwin':
			promise = run('/bin/ps', ['-x', '-o', `pid,ppid,comm=${'a'.repeat(256)},command`], data => lines(data).forEach(line => {
				const pid		= +line.substring(0, 5);
				const ppid		= +line.substring(6, 11);
				if (!isNaN(pid) && !isNaN(ppid)) {
					const command	= line.substring(12, 268).trim();
					const args		= line.substring(270 + command.length);
					processes.push(new Process(command, pid, ppid, args));
				}
			}));
			break;

		default:// linux
			promise = run('/bin/ps', ['-ax', '-o', 'pid,ppid,comm:20,command'], data => lines(data).forEach(line => {
				const pid		= +line.substring(0, 5);
				const ppid		= +line.substring(6, 11);
				if (!isNaN(pid) && !isNaN(ppid)) {
					let command		= line.substring(12, 32).trim();
					let args		= line.substring(33);

					let pos = args.indexOf(command);
					if (pos >= 0) {
						pos = args.indexOf(' ', pos + command.length);
						if (pos < 0)
							pos = args.length;
						command = args.substring(0, pos);
						args	= args.substring(pos + 1);
					}

					processes.push(new Process(command, pid, ppid, args));
				}
			}));
			break;

	}

	await promise;
	return processes;
	/*.sort((a, b) => {
		if (!a.name)
			return !b ? 0 : 1;
		if (!b.name)
			return -1;
		const aLower = a.name.toLowerCase();
		const bLower = b.name.toLowerCase();
		return aLower === bLower ? 0 : aLower < bLower ? -1 : 1;
	}));*/
}

interface Attached {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
}

export function connect(pid: number): Attached | undefined {
	switch (os.platform()) {
		case 'win32':
			break;

			case 'darwin':
			break;

			case 'linux':
			return {
				stdin:	fs.createWriteStream(`/proc/${pid}/fd/0`),
				stdout: fs.createReadStream(`/proc/${pid}/fd/1`),
				stderr:	fs.createReadStream(`/proc/${pid}/fd/2`)
			};
			break;
	}
}
