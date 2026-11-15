'use strict';
// VISTA face engine: Human.js in the guard's phone browser.
// - Opens the camera, checks there is exactly ONE clear face, and turns it into a
//   face template (1024 numbers). No photo is saved or uploaded; video frames stay
//   on the phone and the camera is switched off after each scan.
// - Matching and storage happen in Cloud Functions (see functions/), never here.
// Needs HTTPS (GitHub Pages is fine) or http://localhost.

const VistaFace = (() => {
  const VERSION = '3.3.6'; // Human.js, MIT licence (https://github.com/vladmandic/human)
  const LIB_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${VERSION}/dist/human.esm.js`;
  const MODELS_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${VERSION}/models/`;

  /** Capture rules. A scan collects SAMPLES good frames of the same single face. */
  const CAPTURE = {
    samples: 5,
    minFaceScore: 0.75,     // detector confidence
    minFaceWidth: 0.2,      // face box at least 20% of the frame width (close enough)
    maxAngle: 0.4,          // about 23 degrees of head turn/tilt
    minConsistency: 0.7,    // every sample must look like the same person
    timeoutMs: 30000,
    frameGapMs: 150,
  };
  /** Light on the face (0 = black, 255 = white). Outside this range the scan waits and shows a hint. */
  const LIGHT = { minFace: 45, maxFace: 235, maxBacklight: 70 };

  const CONFIG = {
    modelBasePath: MODELS_URL,
    debug: false,
    warmup: 'none',
    cacheSensitivity: 0, // analyse every frame fully
    filter: { enabled: true, equalization: true, flip: false }, // balances dark/bright light before reading the face
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 3, minConfidence: 0.5, return: false },
      mesh: { enabled: true },
      attention: { enabled: false },
      iris: { enabled: false },
      emotion: { enabled: false },
      description: { enabled: true },
      antispoof: { enabled: false }, // off: faster scan (the guard confirms in person)
      liveness: { enabled: false },
      gear: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  };

  let human = null;
  let loading = null;
  let stream = null;

  class FaceError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  /** Loads Human.js and the face models once (about 10 MB the first time, then cached). */
  function load(onStatus = () => {}) {
    if (human) return Promise.resolve(human);
    if (!loading) {
      loading = (async () => {
        if (!window.isSecureContext) throw new FaceError('insecure', 'Camera needs an https:// link. Open VISTA from GitHub Pages.');
        onStatus('Loading… (first time ~10 MB)');
        const mod = await import(LIB_URL);
        const h = new mod.Human(CONFIG);
        await h.load();
        onStatus('Preparing…');
        await h.warmup({ warmup: 'face' }).catch(() => {});
        human = h;
        return h;
      })().catch((err) => {
        loading = null;
        if (err instanceof FaceError) throw err;
        throw new FaceError('load', 'Could not load face scan. Check internet, or use manual.');
      });
    }
    return loading;
  }

  /** Opens the camera into a <video>. facing: 'environment' (back) or 'user' (front). */
  async function openCamera(video, facing = 'environment', signal) {
    stopCamera(video);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new FaceError('unsupported', 'Use Chrome (Android) or Safari (iPhone).');
    }
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      throw explainCameraError(err);
    }
    // Cancelled while the phone was asking for the camera: switch it straight off
    if (signal?.aborted) { s.getTracks().forEach((t) => t.stop()); throw new FaceError('cancelled', 'Scan cancelled.'); }
    stopCamera(video);
    stream = s;
    video.setAttribute('playsinline', ''); // iPhone: play inside the page, not full screen
    video.muted = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  }

  function stopCamera(video) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  function explainCameraError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new FaceError('permission', 'Camera blocked. Allow camera in browser settings, then reload.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return new FaceError('nocamera', 'No camera found.');
    if (name === 'NotReadableError' || name === 'AbortError') return new FaceError('busy', 'Camera busy. Close other camera apps.');
    return new FaceError('camera', `Camera could not open (${name || 'error'}).`);
  }

  // Small canvas to measure light on the face (reused every frame)
  const lightCanvas = document.createElement('canvas');
  lightCanvas.width = 48; lightCanvas.height = 48;
  const lightCtx = lightCanvas.getContext('2d', { willReadFrequently: true });
  function brightness(video, box) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const [x, y, w, h] = box ? [box[0] * vw, box[1] * vh, box[2] * vw, box[3] * vh] : [0, 0, vw, vh];
    try {
      lightCtx.drawImage(video, x, y, Math.max(1, w), Math.max(1, h), 0, 0, 48, 48);
      const d = lightCtx.getImageData(0, 0, 48, 48).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return sum / (d.length / 4);
    } catch { return null; }
  }
  /** Returns a short hint if the light is bad, otherwise ''. */
  function lightHint(video, boxRaw) {
    const face = brightness(video, boxRaw);
    if (face == null) return '';
    if (face < LIGHT.minFace) return 'Too dark';
    if (face > LIGHT.maxFace) return 'Too bright';
    const all = brightness(video, null);
    if (all != null && all - face > LIGHT.maxBacklight) return 'Light behind face';
    return '';
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Scans the face in front of the camera.
   * onStatus(text, progress 0..1) gives live guidance; signal (AbortSignal) cancels.
   * Resolves { embedding (average), samples (each frame), quality }.
   */
  async function capture(video, { onStatus = () => {}, signal } = {}) {
    const h = await load(onStatus);
    const started = Date.now();
    const samples = [], scores = [];
    onStatus('Point at the visitor\'s face', 0);

    while (samples.length < CAPTURE.samples) {
      if (signal?.aborted) throw new FaceError('cancelled', 'Scan cancelled.');
      if (Date.now() - started > CAPTURE.timeoutMs) {
        throw new FaceError('timeout', 'No clear face. Try better light, or use manual.');
      }
      const res = await h.detect(video);
      if (signal?.aborted) throw new FaceError('cancelled', 'Scan cancelled.');
      const faces = (res.face || []).filter((f) => f.score >= 0.5);
      let hint = '';
      if (!faces.length) hint = 'No face found';
      else if (faces.length > 1) { hint = 'One person only'; samples.length = 0; scores.length = 0; }
      else {
        const f = faces[0];
        const angle = f.rotation?.angle || {};
        const turned = Math.max(Math.abs(angle.yaw || 0), Math.abs(angle.pitch || 0), Math.abs(angle.roll || 0));
        const light = lightHint(video, f.boxRaw);
        if ((f.boxRaw?.[2] || 0) < CAPTURE.minFaceWidth) hint = 'Move closer';
        else if (light) hint = light;
        else if (f.score < CAPTURE.minFaceScore) hint = 'Need more light';
        else if (turned > CAPTURE.maxAngle) hint = 'Look straight';
        else if (!Array.isArray(f.embedding) || f.embedding.length !== 1024) hint = 'Hold still…';
        else {
          samples.push(Array.from(f.embedding));
          scores.push(f.score);
          hint = `Scanning ${samples.length}/${CAPTURE.samples}`;
        }
      }
      onStatus(hint, samples.length / CAPTURE.samples);
      await sleep(CAPTURE.frameGapMs);
    }

    // All samples must be the same person (protects against a face swap mid-scan)
    let consistency = 1;
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) consistency = Math.min(consistency, h.match.similarity(samples[i], samples[j]));
    }
    if (consistency < CAPTURE.minConsistency) {
      throw new FaceError('inconsistent', 'Face changed during scan. One person only, try again.');
    }
    const embedding = samples[0].map((_, k) => mean(samples.map((s) => s[k])));
    const quality = {
      samples: samples.length,
      consistency: round2(consistency),
      faceScore: round2(mean(scores)),
    };
    onStatus('Face captured', 1);
    // embedding = average (cloud backend and old callers); samples/embeddings = the 5 verified frames
    return { embedding, samples, embeddings: samples, quality };
  }

  return { load, openCamera, stopCamera, capture, explainCameraError, FaceError, CAPTURE, VERSION };
})();


// Start loading the face models in the background as soon as the guard opens the Face Scanner tab
document.getElementById('tab-scanner-btn')?.addEventListener('click', () => { VistaFace.load().catch(() => {}); });