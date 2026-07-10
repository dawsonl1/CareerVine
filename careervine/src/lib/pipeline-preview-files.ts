const DB_NAME = "cv-pipeline-preview-files";
const DB_VERSION = 1;
const STORE = "files";

export const PIPELINE_PREVIEW_PDF_MAX_BYTES = 5 * 1024 * 1024;

export interface PipelinePreviewFileMeta {
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

interface PipelinePreviewFileRecord extends PipelinePreviewFileMeta {
  blob: Blob;
}

function storageKey(companyId: number, fileId: string): string {
  return `${companyId}:${fileId}`;
}

export function createPipelinePreviewFileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
  });
}

export function isPipelinePreviewPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export async function putPipelinePreviewFile(companyId: number, file: File): Promise<string> {
  if (!isPipelinePreviewPdf(file)) {
    throw new Error("Only PDF files are supported");
  }
  if (file.size > PIPELINE_PREVIEW_PDF_MAX_BYTES) {
    throw new Error("File exceeds size limit");
  }

  const fileId = createPipelinePreviewFileId();
  const db = await openDb();
  const record: PipelinePreviewFileRecord = {
    blob: file,
    name: file.name,
    mimeType: file.type || "application/pdf",
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
  };
  await idbPut(db, storageKey(companyId, fileId), record);
  return fileId;
}

export async function getPipelinePreviewFileMeta(
  companyId: number,
  fileId: string,
): Promise<PipelinePreviewFileMeta | null> {
  const db = await openDb();
  const record = await idbGet<PipelinePreviewFileRecord>(db, storageKey(companyId, fileId));
  if (!record) return null;
  return {
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    uploadedAt: record.uploadedAt,
  };
}

export async function openPipelinePreviewFile(
  companyId: number,
  fileId: string,
): Promise<string | null> {
  const db = await openDb();
  const record = await idbGet<PipelinePreviewFileRecord>(db, storageKey(companyId, fileId));
  if (!record?.blob) return null;
  return URL.createObjectURL(record.blob);
}

export async function deletePipelinePreviewFile(companyId: number, fileId: string): Promise<void> {
  const db = await openDb();
  await idbDelete(db, storageKey(companyId, fileId));
}
