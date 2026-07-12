import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadFromAppData, requestDriveAccessToken, uploadToAppData } from './googleDrive.js';

describe('googleDrive (Drive appData REST calls)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uploadToAppData creates a new file (POST) when none exists yet', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [] }) }) // list
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'new-file' }) }); // create

    await uploadToAppData('token-123', '{"ciphertext":"..."}');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listUrl, listOpts] = fetchMock.mock.calls[0]!;
    expect(String(listUrl)).toContain('spaces=appDataFolder');
    expect((listOpts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-123' });

    const [uploadUrl, uploadOpts] = fetchMock.mock.calls[1]!;
    expect(String(uploadUrl)).toContain('uploadType=multipart');
    expect((uploadOpts as RequestInit).method).toBe('POST');
  });

  it('uploadToAppData updates the existing file (PATCH) when one is found', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [{ id: 'existing-file' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'existing-file' }) });

    await uploadToAppData('token-123', '{"ciphertext":"..."}');

    const [uploadUrl, uploadOpts] = fetchMock.mock.calls[1]!;
    expect(String(uploadUrl)).toContain('existing-file');
    expect((uploadOpts as RequestInit).method).toBe('PATCH');
  });

  it('uploadToAppData throws on a non-ok upload response', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(uploadToAppData('token', 'x')).rejects.toThrow(/upload failed/i);
  });

  it('downloadFromAppData returns null when no synced file exists', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ files: [] }) });
    expect(await downloadFromAppData('token')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloadFromAppData fetches and returns the file content when found', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [{ id: 'the-file' }] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => '{"ciphertext":"abc"}' });

    const content = await downloadFromAppData('token');
    expect(content).toBe('{"ciphertext":"abc"}');
    const [downloadUrl] = fetchMock.mock.calls[1]!;
    expect(String(downloadUrl)).toContain('the-file');
    expect(String(downloadUrl)).toContain('alt=media');
  });
});

describe('requestDriveAccessToken', () => {
  afterEach(() => {
    delete window.google;
  });

  it('resolves with the access token on success', async () => {
    let capturedCallback: ((resp: { access_token?: string; error?: string }) => void) | undefined;
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => {
            capturedCallback = config.callback;
            return { requestAccessToken: () => capturedCallback?.({ access_token: 'granted-token' }) };
          },
        },
      },
    };

    await expect(requestDriveAccessToken('client-id')).resolves.toBe('granted-token');
  });

  it('rejects when the user declines consent', async () => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () => config.callback({ error: 'access_denied' }),
          }),
        },
      },
    };

    await expect(requestDriveAccessToken('client-id')).rejects.toThrow(/access_denied/);
  });
});
