/* eslint-disable camelcase */
/* eslint-disable no-use-before-define */
import { sheets as _sheets, auth as _auth } from '@googleapis/sheets';
import type { AuthPlus, sheets_v4 } from '@googleapis/sheets';
import { keeper } from '@resolute/std/promise';
import type { Keeper } from '@resolute/std/promise';

export type InputTypes = boolean | string | number | null;

export type RowArray = string[];

export type RowObject = { [key: string]: string };

export type InputRowArray = InputTypes[];
export type InputRowObject = { [key: string]: InputTypes };

export type GoogleAuthInput =
  | { email: string; key: string }
  | { client_email: string; private_key: string };

export interface GSheetOptions {
  jwt?: GoogleAuthInput;
  spreadsheetId: string;
  range: string;
  http2?: boolean;

  preload?: boolean;
  interval?: number;

  headerRows?: number;
  keyTransform?: Gsheet['keyTransform'];
  sanitize?: Gsheet['sanitize'];
  filter?: Gsheet['filter'];
}

export const gSheetDate = (date = new Date()) =>
  `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

export const gSheetDateTime = (date = new Date()) =>
  `${gSheetDate(date)} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;

export const trim = <T extends InputTypes>(arg: T) => {
  if (typeof arg === 'string') {
    return arg.replace(/\s+/g, ' ').trim();
  }
  return arg;
};

export const noChange = (arg: string) => arg;

export const noFilter = () => true;

// From Google’s API (TypeScript/Go To Definition) documentation:
//
// For output, empty trailing rows and columns will not be included.
//
// For input, supported value types are: bool, string, and double. Null values
// will be skipped. To set a cell to an empty value, set the string value to an
// empty string.

export class Gsheet {
  private client: Promise<sheets_v4.Sheets>;
  private auth: Awaited<ReturnType<AuthPlus['getClient']>> | ReturnType<AuthPlus['getClient']>;
  private spreadsheetId: string;
  private range: string;
  private headerRows: number;
  private keyTransform: (arg: string) => string;
  private sanitize: <T extends InputTypes>(arg: T) => string | T;
  private filter: (arg: RowObject | RowArray) => boolean;
  private keptSheet: Keeper<Awaited<ReturnType<Gsheet['getSheet']>>>;
  private keptColumns: Keeper<Awaited<ReturnType<Gsheet['getColumns']>>>;

  constructor(options: GSheetOptions) {
    this.auth = (() => {
      const googleAuth = new _auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      if (options.jwt) {
        const client_email =
          'client_email' in options.jwt ? options.jwt.client_email : options.jwt.email;
        const private_key =
          'private_key' in options.jwt ? options.jwt.private_key : options.jwt.key;
        return googleAuth.fromJSON({ client_email, private_key });
      }
      return googleAuth.getClient();
    })();
    this.client = Promise.resolve(this.auth).then((auth) =>
      _sheets({ version: 'v4', auth, http2: options.http2 ?? false }));
    this.spreadsheetId = options.spreadsheetId;
    this.range = options.range;
    this.headerRows = options?.headerRows ?? 1;
    this.keyTransform = options?.keyTransform ?? noChange;
    this.sanitize = options?.sanitize ?? trim;
    this.filter = options?.filter ?? noFilter;
    this.keptSheet = keeper(this.getSheet.bind(this));
    this.keptColumns = keeper(this.getColumns.bind(this));
    if (options.preload) {
      this.refresh();
    }
    if (options.interval) {
      this.keepFresh(options.interval);
    }
  }

  private async getSheet(range = this.range) {
    // const auth = new google.auth.GoogleAuth();
    const client = await this.client;
    const response = await client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    if (!response.data.values) {
      throw new Error('No data found.');
    }
    return response.data.values as string[][];
  }

  private getHeaderRowsOnly() {
    return this.getSheet(`${this.range}!A${this.headerRows}:ZZZ${this.headerRows}`);
  }

  private getColumnsFromSheetCache() {
    try {
      return this.keptSheet.stale();
    } catch {
      return this.getHeaderRowsOnly();
    }
  }
  private async getColumns() {
    const rows = await this.getColumnsFromSheetCache();
    const columns = rows[this.headerRows - 1];
    if (!columns || !columns.length) {
      throw new Error(`Unable to turn rows into objects. Row at ${this.headerRows} is empty.`);
    }
    return columns.map(this.sanitize).map(this.keyTransform);
  }

  public async columns() {
    return this.keptColumns.get();
  }

  public async rows() {
    const rows = await this.keptSheet.get();
    return rows
      .slice(this.headerRows)
      .map((row) => row.map(this.sanitize))
      .filter(this.filter);
  }

  public async data() {
    // IMPORTANT: Get the rows first--otherwise, if the cache is empty,
    // this.columns() will do its own expensive call to get only the header
    // rows, even though we’re going to need all of the rows immediately after.
    const rows = await this.rows();
    const keys = await this.columns();
    return rows
      .map(
        (row): RowObject =>
          row.reduce((obj, value, index) => {
            if (keys[index]) {
              // eslint-disable-next-line no-param-reassign
              obj[keys[index]] = value;
            }
            return obj;
          }, {} as RowObject),
      )
      .filter(this.filter);
  }

  private async normalizeInputData(arg: InputRowArray | InputRowObject) {
    if (Array.isArray(arg)) {
      return arg;
    }
    // match against lowercase
    const entries = Object.entries(arg).map(([key, val]) => [key.toLowerCase(), val]);
    const columns = await this.columns();
    return columns
      .map((key) => (entries.find(([entryKey]) => entryKey === key.toLowerCase()) || [])[1])
      .map(this.sanitize);
  }

  public async append(arg: InputRowArray | InputRowObject) {
    const row = await this.normalizeInputData(arg);
    if (!row) {
      throw new Error(`Unable to add ${arg}.`);
    }
    const client = await this.client;
    const response = await client.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.range,
      insertDataOption: 'INSERT_ROWS',
      valueInputOption: 'USER_ENTERED',
      requestBody: { range: this.range, values: [row] },
    });
    // TODO: should we do this? Or allow other readers to still get stale content?
    this.keptSheet.fresh();
    if (!(response?.data?.updates?.updatedRows! > 0)) {
      throw new Error('Failed to save your information. Please try again.');
    }
    return response;
  }

  public refresh() {
    this.keptSheet.fresh();
  }

  public keepFresh(interval: number) {
    this.keptSheet.start(interval);
  }
}

export const gsheet = (options: GSheetOptions) => {
  const instance = new Gsheet(options);
  instance.rows = instance.rows.bind(instance);
  instance.data = instance.data.bind(instance);
  instance.keepFresh = instance.keepFresh.bind(instance);
  instance.append = instance.append.bind(instance);
  instance.refresh = instance.refresh.bind(instance);
  return instance;
};

export default gsheet;
