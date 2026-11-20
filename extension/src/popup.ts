// The toolbar popup: pair, see whether a run is using this browser, take it over or
// stop it, forget.

interface Status {
  connection: 'unpaired' | 'connecting' | 'online' | 'offline' | 'refused';
  device?: { name: string; server: string };
  run?: { runId: string; sites: string[]; takenOver?: boolean; tabs?: number };
  pairing?: { userCode: string; verificationUri: string } | { error: string };
  notice?: string;
  keptAnswers?: number;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const send = async <T>(msg: object): Promise<T> => await chrome.runtime.sendMessage(msg) as T;

const STATES: Record<Status['connection'], string> = {
  unpaired: 'Not paired',
  connecting: 'Connecting…',
  online: 'Online: runs can ask for this browser',
  offline: 'Offline: trying again',
  refused: 'Not accepted by the server',
};

function render(s: Status): void {
  const paired = s.connection !== 'unpaired';
  const code = s.pairing && 'userCode' in s.pairing ? s.pairing : null;
  $('unpaired').hidden = paired || !!code;
  $('pairing').hidden = !code;
  $('paired').hidden = !paired;
  if (code) $('code').textContent = code.userCode;
  $('state').textContent = STATES[s.connection];
  $('dot').className = `dot ${s.connection}`;
  $('device').textContent = s.device ? `“${s.device.name}” on ${s.device.server}` : '';
  $('run').hidden = !s.run;
  $('run-sites').textContent = s.run?.sites.join(', ') ?? '';
  $('run-tabs').textContent = (s.run?.tabs ?? 1) > 1 ? `, in ${s.run!.tabs} tabs` : '';
  const mine = s.run?.takenOver === true;
  $('take-over').hidden = mine;
  $('hand-back').hidden = !mine;
  $('run-paused').hidden = !mine;
  $('retry').hidden = s.connection !== 'refused';
  const kept = s.keptAnswers ?? 0;
  $('kept').hidden = kept === 0;
  $('kept-text').textContent = kept === 1 ? 'One chat may use this browser without asking.' : `${kept} chats may use this browser without asking.`;
  const notice = s.pairing && 'error' in s.pairing ? s.pairing.error : s.notice;
  $('notice').hidden = !notice;
  $('notice').textContent = notice ?? '';
}

$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const server = $<HTMLInputElement>('server').value;
  const name = $<HTMLInputElement>('name').value.trim() || 'Chrome';
  let origin: string;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(server.trim()) ? server.trim() : `https://${server.trim()}`);
    origin = u.origin;
  } catch {
    render({ connection: 'unpaired', notice: 'That is not a server address.' });
    return;
  }
  // Chrome's own prompt names the site: the user allows that one server, and no other.
  void chrome.permissions.request({ origins: [`${origin}/*`] }).then((granted) => {
    if (!granted) { render({ connection: 'unpaired', notice: 'Pairing needs permission to reach that server.' }); return; }
    void send({ type: 'pair', server: origin, name });
  });
});
// Asked here, not of the worker: the popup can read it itself, and it is shown whether
// or not a run is going.
void chrome.extension.isAllowedIncognitoAccess().then((allowed) => { $('incognito-off').hidden = allowed; }, () => {});
$('incognito-setting').addEventListener('click', () => { void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); });
$('stop').addEventListener('click', () => { void send({ type: 'stop' }); });
$('take-over').addEventListener('click', () => { void send({ type: 'take-over' }); });
$('hand-back').addEventListener('click', () => { void send({ type: 'hand-back' }); });
$('retry').addEventListener('click', () => { void send({ type: 'retry' }); });
$('forget-kept').addEventListener('click', () => { void send({ type: 'answers:forget' }).then(() => send<Status>({ type: 'status' })).then(render); });
$('forget').addEventListener('click', () => {
  if (!confirm('Forget this browser? Its key is deleted here. To remove it from your account too, use your devices list on the server.')) return;
  void send({ type: 'forget' });
});

chrome.runtime.onMessage.addListener((msg: { type?: string; status?: Status }) => { if (msg.type === 'status' && msg.status) render(msg.status); });
void send<Status>({ type: 'status' }).then(render);
