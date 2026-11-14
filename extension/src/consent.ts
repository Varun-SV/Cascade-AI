// The question a run asks: which sites, if any. Answered to the service worker.

const ask = Number(new URLSearchParams(location.search).get('ask'));
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function send<T>(msg: object): Promise<T> {
  return await chrome.runtime.sendMessage(msg) as T;
}

async function main(): Promise<void> {
  const info = await send<{ runId: string; expiresAt: number; server?: string } | null>({ type: 'consent:get', ask });
  if (!info) { $('who').textContent = 'This request is over.'; ($('allow') as HTMLButtonElement).disabled = true; return; }
  const mins = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000));
  $('who').textContent = `From ${info.server ?? 'your Cascade server'}. This question lapses in about ${mins} min.`;
  $<HTMLInputElement>('sites').focus();

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const sites = $<HTMLInputElement>('sites').value;
    if (!sites.trim()) { showError('Type at least one site, or press Say no.'); return; }
    void answer(sites);
  });
  $('decline').addEventListener('click', () => { void answer(''); });
}

/** Closes only once the extension says it has the answer: a lost reply is not a yes. */
async function answer(sites: string): Promise<void> {
  const r = await send<{ ok?: boolean; error?: string } | undefined>({ type: 'consent:answer', ask, sites }).catch(() => undefined);
  if (r?.ok) { window.close(); return; }
  showError(r?.error ?? 'Cascade did not get your answer. Try again.');
}

function showError(text: string): void {
  const el = $('error');
  el.textContent = text;
  el.hidden = false;
}

void main();
