// Points cloud/server's "#cascade-ai" imports-field entry (package.json) at
// the root workspace's built dist/index.js.
//
// Node's package.json "imports" field rejects any target starting with
// "../" (ERR_INVALID_PACKAGE_TARGET) — targets must stay inside the
// package's own directory. The root build output lives outside cloud/server
// entirely, so this script recreates a pair of symlinks *inside*
// cloud/server/vendor/ that point back out to it; the imports field then
// references those in-package symlinks, which Node happily follows at
// runtime. Re-run (via predev/prebuild) any time dist/ is rebuilt.
import { symlinkSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(here, '..', 'vendor');
const rootDist = path.join(here, '..', '..', '..', 'dist');

mkdirSync(vendorDir, { recursive: true });

for (const [link, target] of [
  ['cascade-ai.js', path.join(rootDist, 'index.js')],
  ['cascade-ai.d.ts', path.join(rootDist, 'index.d.ts')],
]) {
  const linkPath = path.join(vendorDir, link);
  if (existsSync(linkPath)) unlinkSync(linkPath);
  symlinkSync(path.relative(vendorDir, target), linkPath);
}
