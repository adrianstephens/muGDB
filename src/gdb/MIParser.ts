// MI grammar based on https://ftp.gnu.org/old-gnu/Manuals/gdb/html_chapter/gdb_22.html
const VARIABLE		= /^([a-zA-Z_][a-zA-Z0-9_-]*)=/;
const GDB_PROMPT	= '(gdb)';
const RECORD			= /^(\d*)(?:([~@&])|(([*+=^])([a-zA-Z0-9_-]*)))/
const CSTRING		 = /^"((?:[^"\\]|\\.)*?)"/;

// Relative ordering of records in an OUT_OF_BAND_RECORD regexp
const TOKEN_POS	 = 1;
const STREAM_POS	= 2;
const ASYNC_POS	 = 3;

export abstract class OutputRecord {
	public abstract type?: any;
	public klass?: string;
	public results: Record<string, any> = {};

	public constructor(public readonly token: number) {}

	public get isError() { return this.klass === 'error'; }
	isAsyncRecord(): this is AsyncRecord { return this instanceof AsyncRecord; }
	isStreamRecord(): this is StreamRecord { return this instanceof StreamRecord; }
}

//AsyncRecord

export enum AsyncRecordType {
	EXEC		= '*',
	STATUS	= '+',
	NOTIFY	= '=',
	RESULT	= '^',
}

export class AsyncRecord extends OutputRecord {
	constructor(token: number, public type: AsyncRecordType, public klass?: string) {
		super(token);
	}
}

//StreamRecord

export enum StreamRecordType {
	CONSOLE = '~',
	TARGET	= '@',
	LOG		 = '&'
}

export class StreamRecord extends OutputRecord {
	constructor(token: number, public type: StreamRecordType, public cstring: string) {
		super(token);
	}
}


// MI structures

export interface Line {
	line:	string;
	pc:		string;
}

export interface Memory {
	begin:				string,
	offset:				string;
	end:					string;
	contents: 		string
}

export interface Frame {
	level:	  		string; // The frame number, 0 being the topmost frame, i.e., the innermost function.
	addr:	    		string; // The $pc value for that frame.
	func:	    		string; // Function name.
	file:	    		string; // File name of the source file where the function lives.
	fullname:			string; // The full file name of the source file where the function lives.
	line:	    		string; // Line number corresponding to the $pc.
	from:	    		string; // The shared library where this function is defined. This is only given if the frame’s function is not known.
	arch:	    		string; // Frame’s architecture.
}
export interface ListFrames {
	stack: [string, Frame][];
}


export interface Variable {
	name:	        string;	// The name of the varobj.
	numchild:	    string;	// The number of children of the varobj. This number is not necessarily reliable for a dynamic varobj. Instead, you must examine the ‘has_more’ attribute.
	value:	      string;	// The varobj’s scalar value. For a varobj whose type is some sort of aggregate (e.g., a struct), this value will not be interesting. For a dynamic varobj, this value comes directly from the Python pretty-printer object’s to_string method.
	type:	        string;	// The varobj’s type. This is a string representation of the type, as would be printed by the GDB CLI. If ‘print object’ (see set print object) is set to on, the actual (derived) type of the object is shown rather than the declared one.
	'thread-id':  string;	// If a variable object is bound to a specific thread, then this is the thread’s global identifier.
	dynamic:	    string;	// This attribute will be present and have the value ‘1’ if the varobj is a dynamic varobj. If the varobj is not a dynamic varobj, then this attribute will not be present.
	displayhint:	string;	// A dynamic varobj can supply a display hint to the front end. The value comes directly from the Python pretty-printer object’s display_hint method. See Pretty Printing API.
}

export interface CreateVariable extends Variable {
	has_more:	    string;	// For a dynamic varobj, this indicates whether there appear to be any children available. For a non-dynamic varobj, this will be 0.
}

export interface ChildVariable extends Variable {
	exp:	        string;	// 	The expression to be shown to the user by the front end to designate this child. For example this may be the name of a structure member.
	frozen:	      string;	// 	If the variable object is frozen, this variable will be present with a value of 1.
}

export interface ListChildren {
	children: [string, ChildVariable][];
	displayhint:	string;	// 	A dynamic varobj can supply a display hint to the front end. The value comes directly from the Python pretty-printer object’s display_hint method. See Pretty Printing API.
	has_more:	    string;	// 	This is an integer attribute which is nonzero if there are children remaining after the end of the selected range.
	numchild:	    string;
}


export interface OSDataTable {
	nr_rows:			string;
	nr_cols:			string;
	hdr: {
		width: 			string;
		alignment:	string;
		col_name:		string;
		colhdr:			string
	}[];
	body: [string, Record<string, string>][];
}

export interface Module {
	id:								string;
	'target-name':		string;
	'host-name':			string;
	'symbols-loaded': string;
	'thread-group': 	string;
	ranges:						{from: string,to: string}[],
}

export interface Register {
	number:		string;
	value:		string;
}

export interface StackVariable {
	name:			string;
	type?:		string;
	value?:		string;
}
export interface StackVariables {
	variables:		StackVariable[];
}

export interface Symbols {
	debug: {
		filename: string;
		fullname: string;
		symbols: {
			line:					string;
			name: 				string;
			type: 				string
			description:	string;
		}[];
	}[];
}

export interface Instruction {
	address:	      	string; // The address at which this instruction was disassembled.
	'func-name':    	string; // The name of the function this instruction is within.
	offset:	        	string; // The decimal offset in bytes from the start of ‘func-name’.
	inst:	          	string; // The text disassembly for this ‘address’.
	opcodes?:	      	string; // This field is only present for modes 2, 3 and 5, or when the --opcodes option ‘bytes’ or ‘display’ is used. This contains the raw opcode bytes for the ‘inst’ field.
	src_and_asm_line?: {			// For modes 1, 3, 4 and 5, or when the --source option is used
		line:	          string; // The line number within ‘file’.
		file:	          string; // The file name from the compilation unit. This might be an absolute file name or a relative file name depending on the compile command used.
		fullname:	      string; // Absolute file name of ‘file’. It is converted to a canonical form using the source file search path (see Specifying Source Directories) and after resolving all the symbolic links.
		line_asm_insn:	string; // This is a list of tuples containing the disassembly for ‘line’ in ‘file’. The fields of each tuple are the same as for -data-disassemble in mode 0 and 2, so ‘address’, ‘func-name’, ‘offset’, ‘inst’, and optionally ‘opcodes’.
	}
}
export interface Disassemble {
	asm_insns: Instruction[];
}

export interface Thread {
	id:	      		string;	//	The global numeric id assigned to the thread by GDB.
	'target-id':  string;	//	The target-specific string identifying the thread.
	details?:			string;	//	Additional information about the thread provided by the target. It is supposed to be human-readable and not interpreted by the frontend.
	name?:    		string;	//	The name of the thread. If the user specified a name using the thread name command, then this name is given. Otherwise, if GDB can extract the thread name from the target, then that name is given. If GDB cannot find the thread name, then this field is omitted.
	state:	  		string;	//	The execution state of the thread, either ‘stopped’ or ‘running’, depending on whether the thread is presently running.
	frame?:	  		Frame;	//	The stack frame currently executing in the thread. This field is only present if the thread is stopped.
	core?:    		string;	//	The value of this field is an integer number of the processor core the thread was last seen on.
}

export interface ThreadInfo {
	threads: 							Thread[];
	'current-thread-id'?:	string;	// The global id of the currently selected thread
}

export interface BreakpointLocation {
	number:    				string; //	The breakpoint number, or the location number as a dotted pair
	enabled:   				string; //	y: the location is enabled; n: the location is disabled; N: the location is disabled because the breakpoint is disabled.
	addr?:     				string; //	The address of this location as an hexadecimal number; or the string ‘<PENDING>’, for a pending breakpoint; or the string ‘<MULTIPLE>’, for a breakpoint with multiple locations
	addr_flags?:			string; //	Optional field containing any flags related to the address. These flags are architecture-dependent; see Architectures for their meaning for a particular CPU.
	func?:     				string; //	If known, the function in which the location appears. If not known, this field is not present.
	file?:     				string; //	The name of the source file which contains this location, if known. If not known, this field is not present.
	fullname?: 				string; //	The full file name of the source file which contains this location, if known. If not known, this field is not present.
	line?:     				string; //	The line number at which this location appears, if known. If not known, this field is not present.
	'thread-groups'?: string; //	The thread groups this location is in.
}

export interface Breakpoint extends BreakpointLocation {
	type:      						string; //	The type of the breakpoint. For ordinary breakpoints this will be ‘breakpoint’, but many values are possible.
	'catch-type':     		string; //	If the type of the breakpoint is ‘catchpoint’, then this indicates the exact type of catchpoint.
	disp:      						string; //	This is the breakpoint disposition—either ‘del’, meaning that the breakpoint will be deleted at the next stop, or ‘keep’, meaning that the breakpoint will not be deleted.
	at:        						string; //	If the source file is not known, this field may be provided. If provided, this holds the address of the breakpoint, possibly followed by a symbol name.
	pending:   						string; //	If this breakpoint is pending, this field is present and holds the text used to set the breakpoint, as entered by the user.
	'evaluated-by': 			string; //	Where this breakpoint’s condition is evaluated, either ‘host’ or ‘target’.
	thread:    						string; //	If this is a thread-specific breakpoint, then this identifies the thread in which the breakpoint can trigger.
	inferior:  						string; //	If this is an inferior-specific breakpoint, this this identifies the inferior in which the breakpoint can trigger.
	task:      						string; //	If this breakpoint is restricted to a particular Ada task, then this field will hold the task identifier.
	cond:      						string; //	If the breakpoint is conditional, this is the condition expression.
	ignore:    						string; //	The ignore count of the breakpoint.
	enable:    						string; //	The enable count of the breakpoint.
	'traceframe-usage':		string; //	FIXME.
	'static-tracepoint-marker-string-id': string; //	For a static tracepoint, the name of the static tracepoint marker.
	mask:      						string; //	For a masked watchpoint, this is the mask.
	pass:      						string; //	A tracepoint’s pass count.
	'original-location':  string; //	The location of the breakpoint as originally specified by the user. This field is optional.
	times:     						string; //	The number of times the breakpoint has been hit.
	installed: 						string; //	This field is only given for tracepoints. This is either ‘y’, meaning that the tracepoint is installed, or ‘n’, meaning that it is not.
	what:      						string; //	Some extra data, the exact contents of which are type-dependent.
	locations?: BreakpointLocation[]; //	This field is present if the breakpoint has multiple locations. It is also exceptionally present if the breakpoint is enabled and has a single, disabled location.
}


//MIParser

const escapes: Record<string, string> = {
	r: '\r', n: '\n', t: '\t', v: '\v', '"': '"', "'": "'", '\\': '\\'
};

export class MIParser {
	private buffer = '';

	private skip(n: number) {
		this.buffer = this.buffer.substring(n);
	}
	private check(s: string) {
		if (this.buffer.startsWith(s)) {
			this.skip(s.length);
			return true;
		}
		return false;
	}

	public parse(str: string): OutputRecord | undefined {
		let record: OutputRecord | undefined;

		const match = RECORD.exec(str);
		if (match) {
			const token = match[TOKEN_POS] ? parseInt(match[TOKEN_POS]) : NaN;
			this.buffer = str.substring(match[0].length);

			if (match[STREAM_POS]) {
				// stream-record
				record = new StreamRecord(token, match[STREAM_POS] as StreamRecordType, this.parseValue());

			} else if (match[ASYNC_POS]) {
				// async-record
				record = new AsyncRecord(token, match[ASYNC_POS + 1] as AsyncRecordType, match[ASYNC_POS + 2]);

				while (this.check(',')) {
					const result = this.parseResult();
					if (result)
						record.results[result[0]] = result[1];
				}
			}

			return record;
		}
		if (str.trimRight() !== GDB_PROMPT)
			throw new Error('Unexpected GDB symbol found in output.');
	}

	private parseResult(): [string, any] | undefined {
		const match = VARIABLE.exec(this.buffer);
		if (match) {
			this.skip(match[0].length);
			return [match[1], this.parseValue()];
		}
	}

	private parseValue(): any {
		const cstring = CSTRING.exec(this.buffer);
		if (cstring) {
			// cstring
			this.skip(cstring[0].length);
			return cstring[1].replace(/\\([rntv"'\\])/g, (_, char) => escapes[char]);
		}

		if (this.check('{')) {
			// tuple
			const tuple: Record<string, any> = {};
			while (!this.check('}')) {
				const result = this.parseResult();
				if (result)
					tuple[result[0]] = result[1];
				this.check(',');
			}
			return tuple;
		}

		if (this.check('[')) {
			// list
			const list: any = [];
			if ('"{['.includes(this.buffer[0])) {
				// Value list
				while (!this.check(']')) {
					list.push((this.parseValue()));
					this.check(',');
				}

			} else {
				// Result list
				while (!this.check(']')) {
					list.push(this.parseResult());
					this.check(',');
				}
			}
			return list;
		}
	}
}
