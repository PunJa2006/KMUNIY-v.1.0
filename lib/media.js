export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export function mediaType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['isom','iso2','mp41','mp42','avc1','M4V '].includes(bytes.toString('ascii', 8, 12))) return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}
