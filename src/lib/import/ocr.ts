/**
 * Reading a scanned statement.
 *
 * This is the last resort, not the first. Bank, card and CAS statements
 * downloaded from a portal carry a real text layer and are read exactly by
 * `pdf.ts`. OCR is for the cases where no such file exists: a photograph, a
 * scan, an old statement that only survives on paper.
 *
 * **It will make mistakes.** Tesseract is good at prose and noticeably worse at
 * dense numeric tables — 8 against B, 0 against O, 1 against 7 — which is
 * exactly the content of a statement. So every row it produces is forced to LOW
 * confidence regardless of what the parser concludes, and the review screen
 * flags them. A misread digit in a rupee figure is not a rounding error, and
 * the only defence is a human looking at it.
 *
 * On privacy: the engine and its language model are downloaded from a CDN the
 * first time, which is why `cdn.jsdelivr.net` is in the CSP. That is a
 * download. The statement itself is never uploaded anywhere — the recognition
 * runs in a worker on this device.
 */

export interface OcrProgress {
  /** 0..1 across the whole job, not per page. */
  ratio: number;
  message: string;
}

/**
 * Render each page of a PDF to a bitmap.
 *
 * At 2x scale: Tesseract's accuracy falls off badly below roughly 300 DPI, and
 * a statement's figures are small. Rendering larger costs memory for no gain.
 */
export interface RenderedPages {
  images: Blob[];
  /** True when the document was longer than the page cap below. */
  truncated: boolean;
  totalPages: number;
}

export async function renderPdfToImages(
  data: ArrayBuffer,
  password: string | undefined,
  onProgress?: (p: OcrProgress) => void,
): Promise<RenderedPages> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  /*
    A COPY, deliberately. pdf.js transfers the buffer it is given to its
    worker, which detaches the original — so a second pass over the same file
    (checking the page count, then rendering it for OCR) would throw "Cannot
    perform Construct on a detached ArrayBuffer". Slicing costs one allocation
    and makes the caller's buffer reusable.
  */
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password: password || undefined,
    disableFontFace: true,
  });
  const doc = await task.promise;

  const images: Blob[] = [];
  // A 40-page statement at 2x would be gigabytes of canvas and many minutes of
  // recognition. Better to do a useful amount and say so than to hang the tab.
  const limit = Math.min(doc.numPages, 10);

  for (let n = 1; n <= limit; n++) {
    onProgress?.({ ratio: (n - 1) / limit / 2, message: `Rendering page ${n} of ${limit}…` });

    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    if (!canvas.getContext('2d')) {
      throw new Error('This browser could not render the PDF for OCR.');
    }

    /*
      Two non-obvious arguments.

      `canvas` alone, no `canvasContext`: in pdf.js 6 the context form is the
      backwards-compatible one and requires `canvas` to be null. Passing both
      leaves the render task waiting rather than failing — a silent hang.

      `intent: 'print'` is the load-bearing one, and it is not about printing.
      pdf.js drives a display render forward with requestAnimationFrame
      (`useRequestAnimationFrame: !intentPrint` in its own source), and a
      browser freezes rAF in a background tab. OCR takes the better part of a
      minute, so the user will switch tabs — and the render would stop dead,
      mid-document, with no error and a spinner that never finishes. Print
      intent schedules on microtasks instead, which keep running when the tab
      is hidden. It also renders the page as it would appear on paper, which is
      what we want to read anyway.
    */
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) images.push(blob);

    page.cleanup();
    // Release the backing store immediately; ten full-page canvases held at
    // once is enough to be killed on a phone.
    canvas.width = 0;
    canvas.height = 0;
  }

  const totalPages = doc.numPages;
  await task.destroy();
  return { images, truncated: totalPages > limit, totalPages };
}

/** How many pages a PDF has, used to warn before a long OCR run. */
export async function pdfPageCount(data: ArrayBuffer, password?: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), password: password || undefined });
  const doc = await task.promise;
  const n = doc.numPages;
  await task.destroy();
  return n;
}

/**
 * Recognise text in a set of images.
 *
 * Returns lines, so the same extractor used for text PDFs can read them.
 *
 * One thing to know, because it is measured rather than assumed (see
 * `ocr-output.test.ts`, whose fixture is literal tesseract output): **the
 * horizontal spacing does not survive.** A statement row printed as
 *
 *     01/04/2026   SALARY CREDIT APRIL            85,000.00   85,000.00
 *
 * comes back with every run of spaces collapsed to one, whatever the page
 * segmentation mode. So the column heuristic — which column an amount sits in,
 * the clearest debit/credit signal a text-layer PDF offers — is simply gone
 * here.
 *
 * Direction detection still works, because the signal ranked above it is
 * arithmetic rather than positional: previous balance minus this amount
 * equalling this balance proves a debit no matter how the spacing was mangled.
 * That ordering in `statement.ts` looks arbitrary until you read a scan.
 */
export async function ocrImages(
  images: Blob[],
  onProgress?: (p: OcrProgress) => void,
): Promise<string[]> {
  const { createWorker } = await import('tesseract.js');

  /*
    Every asset comes from our own origin — see scripts/vendor-ocr.mjs for why.
    The short version: tesseract.js loads its core inside the worker with
    importScripts(), which `script-src` governs, so the CDN default would have
    meant granting a third party script execution in the origin that holds
    someone's finances.

    `base` is the deployed sub-path (/paisatrack/ on Pages, / elsewhere).
    import.meta.env.BASE_URL is what Vite substitutes, so this is correct in dev,
    in preview and on Pages without a build-time guess.
  */
  const base = `${import.meta.env.BASE_URL}tesseract/`.replace(/\/{2,}/g, '/');
  const assets = new URL(base, location.origin).toString();

  const worker = await createWorker('eng', 1, {
    workerPath: `${assets}worker.min.js`,
    // A directory, not a file: getCore appends the variant it picks after
    // feature-detecting SIMD support.
    corePath: assets.replace(/\/$/, ''),
    langPath: assets.replace(/\/$/, ''),
    gzip: true,
    /*
      Load the worker straight from its URL instead of wrapping it in a Blob.
      The blob wrapper is tesseract.js's default and needs `worker-src blob:` in
      the CSP; a same-origin worker needs only `worker-src 'self'`, which we
      already have. Same result, one fewer concession.
    */
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') {
        onProgress?.({ ratio: 0.5 + m.progress / 2, message: 'Reading the text…' });
      } else if (m.status.includes('loading') || m.status.includes('initializ')) {
        onProgress?.({ ratio: 0.5, message: 'Loading the OCR engine (first time only)…' });
      }
    },
  });

  try {
    // Statements are tables. PSM 6 — "a single uniform block of text" — holds
    // rows together far better than the default page segmentation, which tries
    // to find columns and tends to interleave them.
    await worker.setParameters({ tessedit_pageseg_mode: '6' as never });

    const lines: string[] = [];
    for (let i = 0; i < images.length; i++) {
      onProgress?.({ ratio: 0.5 + i / images.length / 2, message: `Reading page ${i + 1}…` });
      const { data } = await worker.recognize(images[i]);
      lines.push(...data.text.split('\n').filter((l) => l.trim().length > 0));
    }
    return lines;
  } finally {
    await worker.terminate();
  }
}
