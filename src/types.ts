import { noChange, trim } from "./util";

export type InputTypes = boolean | string | number | null;

export type RowArray = any[];

export type RowObject = { [key: string]: any };

export interface Jwt {
    email: string;
    key: string;
    scopes: string[]
}

export interface GSheetOptions {
    jwt: Jwt;
    spreadsheetId: string;
    range: string;

    preload?: boolean;
    interval?: number;

    headerRows?: number;
    keyTransform?: typeof noChange;
    sanitize?: typeof trim;
}
