// Tells the test runner a task is finished. The run id rides in a cookie set
// from ?run= on the first page, so it survives navigation within the site.
(() => {
  const fromUrl = new URLSearchParams(location.search).get('run');
  if (fromUrl) document.cookie = `run=${encodeURIComponent(fromUrl)}; path=/`;
  const run = decodeURIComponent((document.cookie.match(/(?:^|; )run=([^;]*)/) || [])[1] || '');
  window.done = (task) => fetch('/done', { method: 'POST', body: JSON.stringify({ run, task }) });
})();
