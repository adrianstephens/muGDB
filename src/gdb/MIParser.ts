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
//displayhint:	string;	// 	A dynamic varobj can supply a display hint to the front end. The value comes directly from the Python pretty-printer object’s display_hint method. See Pretty Printing API.
//has_more:	    string;	// 	This is an integer attribute which is nonzero if there are children remaining after the end of the selected range.

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
