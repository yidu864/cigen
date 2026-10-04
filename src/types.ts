/**
 * Shared data model for the root/affix learning app.
 *
 * The same types are used by the browser app and by the Node.js import
 * scripts (`scripts/`), so keep this module free of browser-only APIs.
 */

export interface RootComponent {
  /** Normalised morpheme, e.g. `over`, `-able`, `port`. */
  morpheme: string;
  /** Chinese hint extracted next to the morpheme, may be empty. */
  hint: string;
}

export interface Entry {
  id: string;
  word: string;
  meaning: string;
  decomposition: string;
  page?: number;
  components: RootComponent[];
  /** Where this entry came from, e.g. `deepseek:xt2cibe2byagd207uj`. */
  source?: string;
}

export interface RootInfo {
  root: string;
  gloss: string;
  wordCount: number;
  sampleWords: string[];
}

export interface DatasetSourceInfo {
  kind: string;
  [key: string]: unknown;
}

export interface DatasetMeta {
  sourcePdf?: string;
  generatedAt?: string;
  entryCount?: number;
  rootCount?: number;
  sources?: DatasetSourceInfo[];
  [key: string]: unknown;
}

export interface DatasetFile {
  meta?: DatasetMeta;
  roots?: RootInfo[];
  entries?: Entry[];
}

export interface DatasetManifestItem {
  id: string;
  label?: string;
  file: string;
  entryCount?: number;
  rootCount?: number;
  generatedAt?: string;
}

export interface DatasetManifest {
  datasets?: DatasetManifestItem[];
}

export interface Progress {
  version: number;
  /** root -> true when the learner marked it as mastered. */
  mastered: Record<string, boolean>;
  quizCorrect: number;
  quizTotal: number;
  flashSeen: number;
  updatedAt: string;
}

export type SyncBackend = 'remotestorage' | 'webdav' | 'googledrive';

export interface WebDavConfig {
  /** Base collection URL, must end with a slash after normalisation. */
  url: string;
  username?: string;
  password?: string;
}

export interface RemoteStorageConfig {
  /** e.g. `user@5apps.com` */
  userAddress: string;
}

export interface GoogleDriveConfig {
  /** OAuth 2.0 client ID from the Google Cloud console. */
  clientId: string;
}

export interface SyncConfig {
  backend: SyncBackend;
  webdav: WebDavConfig;
  remotestorage: RemoteStorageConfig;
  googledrive: GoogleDriveConfig;
  /** Persist the WebDAV password in localStorage (otherwise sessionStorage). */
  rememberPassword: boolean;
  /** Push progress automatically after every change. */
  autoPush: boolean;
  /** Pull progress right after connecting. */
  autoPullOnConnect: boolean;
}

export type SyncStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
