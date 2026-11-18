// The question a run asks: which sites, if any, in which kind of window. Answered to
// the service worker.

const ask = Number(new URLSearchParams(location.search).get('ask'));
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function send<T>(msg: object): Promise<T> {
  return await chrome.runtime.sendMessage(msg) as T;
}

interface Question {
  runId: string; expiresAt: number; server?: string;
  sites: string[]; canRemember: boolean; windowMode: 'incognito' | 'normal'; incognitoAllowed: boolean;
}

async function main(): Promise<void> {
  const info = await send<Question | null>({ type: 'consent:get', ask });
  if (!info) { $('who').textContent = 'This request is over.'; ($('allow') as HTMLButtonElement).disabled = true; return; }
  const mins = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000));
  $('who').textContent = `From ${info.server ?? 'your Cascade server'}. This question lapses in about ${mins} min.`;

  const sites = $<HTMLInputElement>('sites');
  // What the run says it will open first: filled in, the user's to change.
  if (info.sites.length) {
    sites.value = info.sites.join(' ');
    $('suggested').textContent = 'Filled in with the site the run wants to start on. Add or remove sites as you like.';
    $('suggested').hidden = false;
  }
  const anyPublic = $<HTMLInputElement>('any-public');
  const syncAny = (): void => { $('any-public-note').hidden = !anyPublic.checked; };
  anyPublic.addEventListener('change', syncAny);

  // A private window unless the user last chose otherwise; offered only if Chrome lets us.
  const incognito = $<HTMLInputElement>('window-incognito');
  const normal = $<HTMLInputElement>('window-normal');
  if (!info.incognitoAllowed) {
    incognito.disabled = true;
    $('incognito-off').hidden = false;
    normal.checked = true;
  } else {
    (info.windowMode === 'normal' ? normal : incognito).checked = true;
  }
  $('remember-row').hidden = !info.canRemember;
  sites.focus();

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sites.value.trim() && !anyPublic.checked) { showError('Type at least one site, tick "Any public site", or press Say no.'); return; }
    void answer({ sites: sites.value, anyPublic: anyPublic.checked, incognito: incognito.checked, remember: $<HTMLInputElement>('remember').checked });
  });
  $('decline').addEventListener('click', () => { void answer({ sites: '', anyPublic: false, incognito: true, remember: false }); });
}

/** Closes only once the extension says it has the answer: a lost reply is not a yes. */
async function answer(form: { sites: string; anyPublic: boolean; incognito: boolean; remember: boolean }): Promise<void> {
  const r = await send<{ ok?: boolean; error?: string } | undefined>({ type: 'consent:answer', ask, ...form }).catch(() => undefined);
  if (r?.ok) { window.close(); return; }
  showError(r?.error ?? 'Cascade did not get your answer. Try again.');
}

function showError(text: string): void {
  const el = $('error');
  el.textContent = text;
  el.hidden = false;
}

void main();
