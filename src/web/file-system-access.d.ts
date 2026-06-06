interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string | { type: "seek"; position: number } | { type: "truncate"; size: number }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}
