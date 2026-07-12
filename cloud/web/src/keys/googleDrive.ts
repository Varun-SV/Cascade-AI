// Google Drive appData sync — client-side only. Drive access is obtained via
// Google Identity Services' incremental-consent token flow, scoped to just
// `drive.appdata` (a per-app hidden folder no other app or the Drive UI can
// see). This access token, and the file's plaintext, never touch our server.

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'cascade-keys.enc';

interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void;
}

interface GoogleAccountsOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (resp: { access_token?: string; error?: string }) => void;
  }): TokenClient;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleAccountsOAuth2 } };
  }
}

let gisLoaded: Promise<void> | null = null;

function loadGoogleIdentityServices(): Promise<void> {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisLoaded;
}

export async function requestDriveAccessToken(clientId: string): Promise<string> {
  await loadGoogleIdentityServices();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.access_token) resolve(resp.access_token);
        else reject(new Error(resp.error ?? 'Google Drive authorization was not granted.'));
      },
    });
    client.requestAccessToken();
  });
}

async function findFileId(accessToken: string): Promise<string | null> {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('spaces', 'appDataFolder');
  url.searchParams.set('q', `name='${FILE_NAME}' and trashed=false`);
  url.searchParams.set('fields', 'files(id)');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google Drive list failed: HTTP ${res.status}`);
  const body = (await res.json()) as { files?: Array<{ id: string }> };
  return body.files?.[0]?.id ?? null;
}

export async function uploadToAppData(accessToken: string, content: string): Promise<void> {
  const existingId = await findFileId(accessToken);
  const metadata = existingId ? {} : { name: FILE_NAME, parents: ['appDataFolder'] };
  const boundary = 'cascade-cloud-boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Google Drive upload failed: HTTP ${res.status}`);
}

export async function downloadFromAppData(accessToken: string): Promise<string | null> {
  const fileId = await findFileId(accessToken);
  if (!fileId) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google Drive download failed: HTTP ${res.status}`);
  return res.text();
}
