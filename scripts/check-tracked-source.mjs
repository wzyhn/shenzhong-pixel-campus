import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(?:^|\/)(?:private|node_modules|\.build)(?:\/|$)|(?:^|\/)\.env$|\.(?:mp3|webp|png|zip|pem|dump)$/i;
const prohibitedText = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /const messages = Object\.freeze\(\{\s*['"]/,
  /data:image\/webp;base64,[A-Za-z0-9+/]{4096}/,
];
const problems = [];
for (const file of files) {
  if (forbidden.test(file)) {
    problems.push(file);
    continue;
  }
  const bytes = await readFile(file);
  if (bytes.includes(0) || bytes.length > 1_500_000 || prohibitedText.some((pattern) => pattern.test(bytes.toString('utf8')))) {
    problems.push(file);
  }
}
if (problems.length) throw new Error('Review tracked files before publication: ' + problems.join(', '));
console.log('Reviewed ' + files.length + ' tracked source paths against the publication gate');
