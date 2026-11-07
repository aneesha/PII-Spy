import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function verifyModelFile(path, file) {
  const metadata = await stat(path);
  if (metadata.size !== file.size) throw new Error(`Incorrect size: ${file.local}`);
  const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
  if (file.gitSha1) hash.update(`blob ${file.size}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== (file.sha256 || file.gitSha1)) {
    throw new Error(`Checksum mismatch: ${file.local}`);
  }
}
