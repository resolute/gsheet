export const gSheetDate = (date = new Date()) =>
    `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

export const gSheetDateTime = (date = new Date()) =>
    `${gSheetDate(date)} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;

export const trim = <T>(arg: T) => {
    if (typeof arg === 'string') {
        return arg.replace(/\s+/g, ' ').trim();
    }
    return arg;
}

export const noChange = (arg: string) => arg;
