/**
 * Reading a scan with the Worker instead of the on-device engine.
 *
 * This is the escape hatch, not the default. Tesseract runs first and runs
 * locally; this exists for the cases it cannot handle — a photograph taken at
 * an angle, a faded thermal print, a statement scanned at 150 DPI — where the
 * honest alternative is typing forty rows by hand.
 *
 * **It uploads the statement.** That is the whole cost and it is not hedged
 * anywhere in the UI. Nothing else in PaisaTrack sends a document off the
 * device, and this does it only when the user presses the button that says so.
 *
 * ## The model transcribes; this file does not trust it to think
 *
 * A vision model asked for structured transactions returns beautifully-formed
 * JSON containing invented figures. Asked to transcribe, it mostly copies. So
 * the Worker's prompt asks only for a transcription, and the text comes back
 * through exactly the same parser that reads a text-layer PDF — the same
 * direction hierarchy, the same categories, the same de-duplication.
 *
 * That reuse is the safety property. `extractTransactions` checks every row
 * against the statement's own running balance, and it has no idea whether a
 * human, Tesseract or an LLM produced the number. A hallucinated amount fails
 * to reconcile and is flagged; a correct one agrees. The check that was built
 * to read columns turns out to be the thing that catches a model making things
 * up.
 */
import { postToWorker, type WorkerCall } from '@/lib/server/config';
import type { OcrProgress } from './ocr';

/**
 * The longest edge a page is scaled to before upload.
 *
 * Statements are read at the glyph level, and 1600px across A4 is roughly
 * 140 DPI — comfortably enough for printed figures, while keeping one page
 * near 200 kB rather than several megabytes. Sending more costs upload time on
 * a phone connection and buys the model nothing.
 */
const MAX_EDGE = 1600;

/** JPEG rather than PNG: a quarter of the bytes, and no visible cost on text at q0.9. */
const QUALITY = 0.9;

/**
 * Normalise an image to a base64 JPEG, on this device.
 *
 * The base64 is produced here rather than in the Worker on purpose. Workers
 * Free allows 10ms of CPU per request, and touching every byte of a megabyte
 * image would spend more than that before any work began. The browser has CPU
 * to spare; the Worker does not.
 */
async function toBase64Jpeg(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the image.');

  // White underneath: a transparent PNG flattened onto the default black would
  // render the text invisible, which reads as "the model saw nothing".
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);

  canvas.width = 0;
  canvas.height = 0;

  // Strip the `data:image/jpeg;base64,` prefix — the binding wants the payload.
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('This browser could not encode the image.');
  return dataUrl.slice(comma + 1);
}

export interface ServerOcrResponse {
  lines: string[];
  pages: number;
  failures: string[];
}

/**
 * Send rendered pages to the Worker and get transcribed lines back.
 *
 * Pages are sent in one request so the Worker makes one decision about the
 * budget, and because a partially-uploaded statement is not useful.
 */
export async function readViaServer(
  call: WorkerCall,
  images: Blob[],
  onProgress?: (p: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<ServerOcrResponse> {
  if (images.length === 0) throw new Error('There was nothing to read.');

  const encoded: string[] = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.({
      ratio: (i / images.length) * 0.4,
      message: `Preparing page ${i + 1} of ${images.length}…`,
    });
    encoded.push(await toBase64Jpeg(images[i]));
  }

  onProgress?.({
    ratio: 0.45,
    message:
      images.length === 1
        ? 'Uploading the page and waiting for the model…'
        : `Uploading ${images.length} pages and waiting for the model…`,
  });

  const response = await postToWorker<ServerOcrResponse>(call, '/ocr', { pages: encoded }, signal);

  onProgress?.({ ratio: 0.95, message: 'Reading the result…' });
  return response;
}
