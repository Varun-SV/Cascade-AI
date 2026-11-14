// The toolbar popup: pair, see whether a run is using this browser, stop it, forget.

interface Status {
  connection: 'unpaired' | 'connecting' | 'online' | 'offline' | 'refused';
  device?: { name: string; server: string };
  run?: { runId: string; sites: string[] };
  pairing?: { userCode: string; verificationUri: string } | { error: string };
  notice?: string;
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
  $('retry').hidden = s.connection !== 'refused';
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
$('stop').addEventListener('click', () => { void send({ type: 'stop' }); });
$('retry').addEventListener('click', () => { void send({ type: 'retry' }); });
$('forget').addEventListener('click', () => {
  if (!confirm('Forget this browser? Its key is deleted here. To remove it from your account too, use your devices list on the server.')) return;
  void send({ type: 'forget' });
});

chrome.runtime.onMessage.addListener((msg: { type?: string; status?: Status }) => { if (msg.type === 'status' && msg.status) render(msg.status); });
void send<Status>({ type: 'status' }).then(render);
