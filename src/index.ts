import { google } from 'googleapis';

import { GSheetOptions, RowArray, RowObject } from './types';

import { noChange, trim, gSheetDate, gSheetDateTime } from './util';

// From Google’s API (TypeScript/Go To Definition) documentation:
// 
// For output, empty trailing rows and columns will not be included.
//
// For input, supported value types are: bool, string, and double. Null values
// will be skipped. To set a cell to an empty value, set the string value to an
// empty string.

const sheets = google.sheets('v4');

const gsheet = ({
    jwt,
    spreadsheetId,
    range,

    // optional:
    preload = true,
    headerRows = 1,
    keyTransform = noChange,
    sanitize = trim,
    interval,
}: GSheetOptions) => {

    let cache: Promise<RowArray[]> | undefined;
    let columnCache: Promise<RowArray> | undefined;
    let timer: NodeJS.Timeout;

    const auth = new google.auth.JWT(jwt);

    const _fetch = async (rangeOverride = range) => {
        const response = await sheets.spreadsheets.values.get({
            auth, spreadsheetId, range: rangeOverride
        });
        if (typeof response.data.values === 'undefined') {
            throw new Error('No data found.');
        }
        return response.data.values;
    };

    const _raw = async (): Promise<RowArray[]> => {
        if (!cache) {
            refresh();
        }
        return cache!;
    }

    const _columns = async () => {
        if (!(headerRows > 0)) {
            throw new Error('Unable to turn rows into objects without a `headerRows` > 0');
        }
        if (!columnCache) {
            columnCache = _fetch(`${range}!A${headerRows}:ZZZ${headerRows}`)
                .then((rows) => rows[headerRows - 1]);
        }
        const columns = await columnCache;
        if (!columns || !columns.length) {
            throw new Error(`Unable to turn rows into objects. Row at ${headerRows} is empty.`);
        }
        return columns.map(sanitize).map(keyTransform);
    }

    const refresh = async () => {
        cache = _fetch();
        if (headerRows > 0) {
            columnCache = cache.then((rows) => rows[headerRows - 1]);
        }
        await cache;
        return;
    }

    const rows = async () =>
        (await _raw()).slice(headerRows).map(row => row.map(sanitize));


    const data = async () => {
        const keys = await _columns();
        return (await rows())
            .map((row): RowObject => row
                .map(sanitize)
                .reduce((obj, value, index) => {
                    obj[keys[index]] = value;
                    return obj;
                }, {}));
    }


    const keepFresh = (timeout = 1000 * 60 * 60 * 30) => {
        if (timer) {
            clearInterval(timer);
        }
        timer = setInterval(async () => {
            try {
                const response = _fetch();
                await response;
                cache = response;
            } catch (error) {
                console.warn(`Failed to refresh Google Sheet ${spreadsheetId}:`, error);
            }
        }, timeout);
        timer.unref();
    }

    const append = async (arg: RowArray | RowObject) => {
        let row: RowArray | undefined;
        if (Array.isArray(arg)) {
            row = arg;
        } else {
            // TODO: revisit this key matching
            // // matching against keyTransform case:
            // row = (await _columns()).map((key) => arg[key]).map(sanitize);
            // match against lowercase
            const entries = Object.entries(arg).map(([key, val]) => [key.toLowerCase(), val]);
            row = (await _columns()).map((key) => (entries.find(([entryKey]) => entryKey === key.toLowerCase()) || [])[1]).map(sanitize);
        }
        if (!row) {
            throw new Error(`Unable to add ${arg}.`);
        }
        const response = await sheets.spreadsheets.values.append({
            auth,
            spreadsheetId,
            range,
            insertDataOption: 'INSERT_ROWS',
            valueInputOption: 'USER_ENTERED',
            requestBody: { range, values: [row] },
        });
        // update the cache with these values
        // TODO: this gets difficult because the cache may be:
        // 1. finished
        // 2. updating, and will get the latest row we just added
        // 3. updating, but will MISS the latest row we just added
        if (cache) {
            // TODO: MUST CHECK FOR CASE #2 WHERE THE CACHE CONTAINS THE DATA WE’RE ADDING
            cache = Promise.resolve([...(await cache), row]);
        }
        if (!(response.data.updates && response.data.updates.updatedRows! > 0)) {
            throw new Error('Failed to save your information. Please try again.');
        }
        return response;
    }


    if (preload) {
        refresh();
    }
    if (interval) {
        keepFresh(interval);
    }

    return {
        rows,
        data,
        append,
        refresh,
        keepFresh,
    }

};

gsheet.gSheetDate = gSheetDate;

gsheet.gSheetDateTime = gSheetDateTime;

export = gsheet;