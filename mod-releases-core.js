const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function listModReleases(releaseDir) {
  if (!releaseDir || !fs.existsSync(releaseDir)) return [];
  return fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .map((entry) => releaseMetadata(releaseDir, entry.name))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || right.filename.localeCompare(left.filename));
}

function findModReleaseFile(releaseDir, filename) {
  if (!releaseDir || !filename || path.basename(filename) !== filename) return null;
  if (!filename.toLowerCase().endsWith('.jar')) return null;
  const root = path.resolve(releaseDir);
  const filePath = path.resolve(root, filename);
  if (path.dirname(filePath) !== root) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

function releaseMetadata(releaseDir, filename) {
  const filePath = findModReleaseFile(releaseDir, filename);
  if (!filePath) return null;
  const stat = fs.statSync(filePath);
  return {
    filename,
    modName: modNameFromFilename(filename),
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    sha256: sha256File(filePath),
  };
}

function modNameFromFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.includes('autoauction') || lower.includes('auto-auction')) return 'AutoAuction';
  if (lower.includes('altmanager') || lower.includes('alt-manager')) return 'Alt Manager';
  return filename.replace(/\.jar$/i, '');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  listModReleases,
  findModReleaseFile,
  modNameFromFilename,
};
