/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  /** Optional Google OAuth client ID for the Google Drive sync backend. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Optional default remoteStorage user address. */
  readonly VITE_REMOTESTORAGE_ADDRESS?: string;
  /** Optional default WebDAV URL, e.g. https://dav.example.com/remote.php/dav/files/user/cigen/ */
  readonly VITE_WEBDAV_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
