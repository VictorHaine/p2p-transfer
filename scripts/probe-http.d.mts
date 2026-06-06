export function probeErrorMessage(error: unknown): string;
export function requiredUrl(value: unknown): URL;
export function optionalOrigin(value: unknown): string | undefined;
export function readBoundedResponseText(response: Response, maxBytes: number): Promise<string>;
