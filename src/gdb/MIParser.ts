// MI grammar based on https://ftp.gnu.org/old-gnu/Manuals/gdb/html_chapter/gdb_22.html
const VARIABLE = /^([a-zA-Z_][a-zA-Z0-9_-]*)=/;
const GDB_PROMPT = '(gdb)';
const RECORD = /^(\d*)(?:([~@&])|(([*+=])([a-zA-Z0-9_-]*))|(\^(done|running|connected|error|exit)))/

// Relative ordering of records in an OUT_OF_BAND_RECORD regexp
const TOKEN_POS = 1;
const STREAM_POS = 2;
const ASYNC_POS = 3;
const RESULT_POS = 6;

export abstract class OutputRecord {
  public response: string = '';
  public abstract type?: any;
  protected results: Record<string, any> = {};

  public constructor(public readonly token: number) {}

  public addResult(result: [string, any]) {
    this.results[result[0]] = result[1];
  }

  public getResult(key: string): any {
    return this.results[key];
  }

  public prettyPrint(): string {
    return this.response;
  }
}

//AsyncRecord

export enum AsyncRecordType {
  EXEC = '*',
  STATUS = '+',
  NOTIFY = '='
}

export const STOPPED = 'stopped';
export const RUNNING = 'running';
export const ERROR = 'error';

export class AsyncRecord extends OutputRecord {
  constructor(token: number, public type: AsyncRecordType, public klass?: string) {
    super(token);
  }
}

//ResultRecord

export enum ResultRecordType {
  DONE = 'done',
  RUNNING = 'running',
  CONNECTED = 'connected',
  ERROR = 'error',
  EXIT = 'exit',
}

export class ResultRecord extends OutputRecord {
  public type?: ResultRecordType;
  constructor(token: number, public klass?: string) {
    super(token);
  }
}

//StreamRecord

enum StreamRecordType {
  CONSOLE = '~',
  TARGET = '@',
  LOG = '&'
}

export class StreamRecord extends OutputRecord {
  constructor(token: number, public type: StreamRecordType) {
    super(token);
  }

  public prettyPrint(): string {
    return this.response.slice(2, -1);
  }
}

//MIParser

export class MIParser {
  private buffer: string = '';

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
      const token = match[TOKEN_POS] ? parseInt(match[TOKEN_POS]) : NaN;;
      this.skip(match[0].length);

      if (match[STREAM_POS]) {
        // stream-record
        record = new StreamRecord(token, match[STREAM_POS] as StreamRecordType);

      } else if (match[ASYNC_POS]) {
        // async-record
        record = new AsyncRecord(token, match[ASYNC_POS + 1] as AsyncRecordType, match[ASYNC_POS + 2]);

        while (this.check(',')) {
          const result = this.parseResult();
          if (result)
            record.addResult(result);
        }

      } else if (match[RESULT_POS]) {
        // result-record
        record = new ResultRecord(token, match[RESULT_POS + 1]);

        while (this.check(',')) {
          const result = this.parseResult();
          if (result)
            record.addResult(result);
        }
      }

      if (record)
        record.response = str;
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
    if (this.check('"')) {
      // cstring
      const i = this.buffer.indexOf('"');
      if (i === -1)
        throw new Error('missing ": ' + this.buffer);
      const value = this.buffer.substring(0, i);
      this.skip(i + 1);
      return value;
    }

    if (this.check('{')) {
      // tuple
      const tuple = {};
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
