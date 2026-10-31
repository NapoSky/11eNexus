export function requireNode26(version = process.versions.node): void {
  if (!/^26\.\d+\.\d+$/.test(version))
    throw Object.assign(new Error('Node.js 26 is required.'), { code: 'UnsupportedNodeVersion' });
}
