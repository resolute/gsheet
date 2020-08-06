import { google, Auth } from 'googleapis';
import keep, { PromiseKeeper } from '@resolute/promise-keeper';

export type InputTypes = boolean | string | number | null;

export type RowArray = string[];

export type RowObject = { [key: string]: string };

export type InputRowArray = InputTypes[];
export type InputRowObject = { [key: string]: InputTypes };

export type GoogleAuth = Auth.JWT;

export interface GSheetOptions {
  jwt: {
    email: string;
    key: string;
    scopes: string[]
  };
  spreadsheetId: string;
  range: string;

  preload?: boolean;
  interval?: number;

  headerRows?: number;
  keyTransform?: Gsheet['keyTransform'];
  sanitize?: Gsheet['sanitize'];
  filter?: Gsheet['filter'],
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

const sheets = google.sheets('v4');

export class Gsheet {
  private auth: GoogleAuth;
  private spreadsheetId: string;
  private range: string;
  private headerRows: number;
  private keyTransform: (arg: string) => string;
  private sanitize: <T extends InputTypes>(arg: T) => string | T;
  private filter: (arg: RowObject | RowArray) => boolean;
  private keptSheet: PromiseKeeper<Gsheet['getSheet']>;
  private keptColumns: PromiseKeeper<Gsheet['getColumns']>;

  constructor(options: GSheetOptions) {
    this.auth = new google.auth.JWT(options.jwt);
    this.spreadsheetId = options.spreadsheetId;
    this.range = options.range;
    this.headerRows = options?.headerRows ?? 1;
    this.keyTransform = options?.keyTransform ?? noChange;
    this.sanitize = options?.sanitize ?? trim;
    this.filter = options?.filter ?? noFilter;
    this.keptSheet = keep(this.getSheet.bind(this));
    this.keptColumns = keep(this.getColumns.bind(this));
    if (options.preload) {
      this.refresh();
    }
    if (options.interval) {
      this.keepFresh(options.interval);
    }
  }

  private async getSheet(range = this.range) {
    const response = await sheets.spreadsheets.values.get({
      auth: this.auth,
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
      return this.keptSheet.getSettledOrThrowSync();
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
    return columns
      .map(this.sanitize)
      .map(this.keyTransform);
  }

  public async columns() {
    return this.keptColumns.getSettled();
  }

  public async rows() {
    const rows = await this.keptSheet.getSettled();
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
      .map((row): RowObject => row
        .reduce((obj, value, index) => {
          if (keys[index]) {
            // eslint-disable-next-line no-param-reassign
            obj[keys[index]] = value;
          }
          return obj;
        }, {}))
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
      .map((key) => (entries
        .find(([entryKey]) => entryKey === key.toLowerCase()) || [])[1])
      .map(this.sanitize);
  }

  public async append(arg: InputRowArray | InputRowObject) {
    const row = await this.normalizeInputData(arg);
    if (!row) {
      throw new Error(`Unable to add ${arg}.`);
    }
    const response = await sheets.spreadsheets.values.append({
      auth: this.auth,
      spreadsheetId: this.spreadsheetId,
      range: this.range,
      insertDataOption: 'INSERT_ROWS',
      valueInputOption: 'USER_ENTERED',
      requestBody: { range: this.range, values: [row] },
    });
    this.keptSheet.purge();
    if (!(response?.data?.updates?.updatedRows! > 0)) {
      throw new Error('Failed to save your information. Please try again.');
    }
    return response;
  }

  public refresh() {
    this.keptSheet.refresh();
  }

  public keepFresh(interval: number) {
    this.keptSheet.keepFresh(interval);
  }
}

export default (options: GSheetOptions) => {
  const instance = new Gsheet(options);
  instance.rows = instance.rows.bind(instance);
  instance.data = instance.data.bind(instance);
  instance.keepFresh = instance.keepFresh.bind(instance);
  instance.append = instance.append.bind(instance);
  instance.refresh = instance.refresh.bind(instance);
  return instance;
};
