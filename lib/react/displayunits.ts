export enum Units {
    metric = 0,
    british = 1
}

export function convertClimb(c: number, units: boolean | Units): [number, string] {
    return [Math.round(c * (units ? 19.43844 : 10)) / 10, units ? 'kt' : 'm/s'];
}

export function convertHeight(c: number, units: number | boolean | Units): [number, string] {
    return [Math.round(c * (units ? 3.28084 : 1)), units ? 'ft' : 'm'];
}

export function displayClimb(c: number, units: boolean | Units): string {
    return convertClimb(c, units).join('');
}

export function displayHeight(c: number, units: number | boolean | Units): string {
    return convertHeight(c, units).join('');
}
