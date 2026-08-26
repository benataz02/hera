import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json') as { name: string; version: string };

// Read name and version directly from package.json rather than process.env.npm_package_name /
// process.env.npm_package_version. Those env vars are only injected by npm when the process is
// started via an npm script (e.g. `npm start`). They are undefined when the app is launched
// directly with `node dist/index.js`, inside Docker, or via a process manager — causing silent
// fallbacks to wrong values. Reading from the file is always reliable.
export const pkgName = pkg.name;
export const pkgVersion = pkg.version;
