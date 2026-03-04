interface Result {
    value: number;
    label: string;
}

export function createResult(value: number, label: string): Result {
    return { value, label };
}
