export function safeChildEnv(): Record<string, string>;
export function isolatedChildEnv(privateHome: string): Record<string, string>;
export function parseJsonEvidence(text: string, label: string): unknown;
export function appendBoundedOutput(current: string, chunk: Buffer): string;
export function renderCommandForLog(command: string, args: string[]): string;
export function expectedPackedTarballName(packageName: string, packageVersion: string): string;
export function optionalProvidedTarball(): string | undefined;
export function stageVerifiedTarball(tarball: string, destination: string): Promise<string>;
export function readBoundedResponseText(response: Response, maxBytes: number): Promise<string>;
