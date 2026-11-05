/**
 * Indian Banknote Identifier - app.js
 * Powered by ONNX Runtime Web (MobileNetV3 PyTorch Model)
 *
 * Pipeline Overview:
 * 1. Preprocessing: 224x224 Offscreen Canvas -> NCHW Planar RGB Layout -> ImageNet Normalization.
 * 2. Inference: ONNX Runtime Web session (WebGL with WebAssembly fallback).
 * 3. Softmax: Numerical stability scaling for probabilities.
 * 4. Temporal Consensus: 7-frame sliding window with 5/7 voting & delta margin gating.
 */

class IndianBanknoteIdentifier {
  constructor() {
    // Relative paths safe for GitHub Pages deployments
    this.MODEL_PATH = './model/currency_mobilenet.onnx';
    this.CLASSES_PATH = './model/classes.json';

    // Model Dimensions & Normalization Constants (ImageNet)
    this.INPUT_WIDTH = 224;
    this.INPUT_HEIGHT = 224;
    this.MEAN = [0.485, 0.456, 0.406];
    this.STD = [0.229, 0.224, 0.225];

    // DOM Elements
    this.video = document.getElementById('camera-stream');
    this.announcer = document.getElementById('announcer');
    this.displayNote = document.getElementById('display-note');
    this.displayTally = document.getElementById('display-tally');
    this.badgeTorch = document.getElementById('badge-torch');
    this.guidanceTip = document.getElementById('guidance-tip');
    this.debugDisplay = document.getElementById('debug-display');
    this.surface = document.getElementById('app-surface');
    this.gateOverlay = document.getElementById('gate-overlay');
    this.btnGateStart = document.getElementById('btn-gate-start');

    // Preprocessing Offscreen Canvas
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = this.INPUT_WIDTH;
    this.offscreenCanvas.height = this.INPUT_HEIGHT;
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });

    // ONNX Session & Labels
    this.session = null;
    this.classes = [];
    this.inputName = 'input';
    this.outputName = 'output';

    // Stream & Hardware State
    this.stream = null;
    this.videoTrack = null;
    this.isTorchOn = false;
    this.isTallyMode = Boolean(this.displayTally);
    this.isRunning = false;

    // Financial State
    this.sessionTotal = 0;
    this.currentAnnouncedNote = null;
    this.lastAnnouncementTime = 0;
    this.lastActiveVisionTime = Date.now();

    // Temporal Consensus Parameters
    this.WINDOW_SIZE = 7;
    this.MIN_CONSISTENT_FRAMES = 5;
    this.MIN_CONFIDENCE_THRESHOLD = 0.82;
    this.CONFIDENCE_MARGIN = 0.25;
    this.ANNOUNCE_COOLDOWN_MS = 2800;
    this.NOISE_RESET_WINDOW_MS = 3000;
    this.INFERENCE_INTERVAL_MS = 140;

    this.predictionHistory = [];

    // Multi-Sense Haptic Patterns
    this.HAPTIC_PROFILES = {
      10: [100],
      20: [100, 50, 100],
      50: [300],
      100: [300, 100, 100],
      200: [300, 100, 300],
      500: [300, 100, 300, 100, 300],
      2000: [400, 100, 400],
      reset: [80, 50, 80, 50, 80],
      torch: [60]
    };

    // Pronunciation Map
    this.WORDS_MAP = {
      10: "Ten",
      20: "Twenty",
      50: "Fifty",
      100: "One hundred",
      200: "Two hundred",
      500: "Five hundred",
      2000: "Two thousand"
    };

    // Gesture State
    this.lastTapTime = 0;
    this.singleTapTimer = null;
    this.touchStartTime = 0;
    this.longPressTimer = null;

    this.bindInit();
  }

  bindInit() {
    this.btnGateStart.addEventListener('click', () => this.unlockAndStart());
    this.registerServiceWorker();
  }

  async unlockAndStart() {
    this.gateOverlay.classList.add('hidden');
    this.speakResult("Starting camera and compiling ONNX neural engine.", true);

    try {
      await Promise.all([this.initCamera(), this.loadOnnxModel()]);
      this.bindGestures();
      this.bindAccessibleButtons();
      this.isRunning = true;
      this.speakResult("Scanner active. Hold banknote steady.", true);
      this.predictLoop();
    } catch (err) {
      console.error("Initialization failure:", err);
      if (this.guidanceTip) {
        this.guidanceTip.textContent = "Error: Model compilation failed";
      }
      this.speakResult("Engine initialization failed. Please reload and check permissions.", true);
    }
  }

  /* ---------------- HARDWARE & CAMERA ---------------- */

  async initCamera() {
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.videoTrack = this.stream.getVideoTracks()[0];

    return new Promise((resolve) => {
      this.video.onloadedmetadata = () => {
        this.video.play();
        resolve();
      };
    });
  }

  async toggleTorch() {
    if (!this.videoTrack) return;

    try {
      const caps = this.videoTrack.getCapabilities ? this.videoTrack.getCapabilities() : {};
      if (!caps.torch) {
        this.speakResult("Flashlight unavailable on this device.", true);
        return;
      }

      this.isTorchOn = !this.isTorchOn;
      await this.videoTrack.applyConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });

      this.triggerHaptic(this.HAPTIC_PROFILES.torch);
      if (this.badgeTorch) {
        this.badgeTorch.textContent = `TORCH: ${this.isTorchOn ? 'ON' : 'OFF'}`;
        this.badgeTorch.classList.toggle('badge-dim', !this.isTorchOn);
      }
      this.speakResult(`Flashlight ${this.isTorchOn ? 'on' : 'off'}.`, true);
    } catch (err) {
      this.speakResult("Unable to toggle flashlight.", true);
    }
  }

  /* ---------------- ONNX MODEL & PREPROCESSING ---------------- */

  async loadOnnxModel() {
    // Configure WebAssembly execution settings
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    // Fetch classes dictionary
    const classRes = await fetch(this.CLASSES_PATH);
    this.classes = await classRes.json();

    // Create session prioritizing WebGL with WASM fallback
    this.session = await ort.InferenceSession.create(this.MODEL_PATH, {
      executionProviders: ['webgl', 'wasm']
    });

    // Detect actual input and output layer names dynamically
    this.inputName = this.session.inputNames[0] || 'input';
    this.outputName = this.session.outputNames[0] || 'output';

    // Warm-up pass to compile WebGL shaders and allocate tensors
    const dummyData = new Float32Array(1 * 3 * this.INPUT_WIDTH * this.INPUT_HEIGHT);
    const dummyTensor = new ort.Tensor('float32', dummyData, [1, 3, this.INPUT_WIDTH, this.INPUT_HEIGHT]);
    await this.session.run({ [this.inputName]: dummyTensor });
  }

  preprocessFrame() {
    // Center-crop video square directly into 224x224 offscreen surface
    const vWidth = this.video.videoWidth;
    const vHeight = this.video.videoHeight;
    const minDim = Math.min(vWidth, vHeight);
    const startX = (vWidth - minDim) / 2;
    const startY = (vHeight - minDim) / 2;

    this.offscreenCtx.drawImage(
      this.video,
      startX, startY, minDim, minDim,
      0, 0, this.INPUT_WIDTH, this.INPUT_HEIGHT
    );

    const frameData = this.offscreenCtx.getImageData(0, 0, this.INPUT_WIDTH, this.INPUT_HEIGHT).data;
    const channelSize = this.INPUT_WIDTH * this.INPUT_HEIGHT;
    const floatData = new Float32Array(3 * channelSize);

    // Transform Interleaved RGBA to Planar NCHW with ImageNet normalization
    for (let i = 0; i < channelSize; i++) {
      const r = frameData[i * 4];
      const g = frameData[i * 4 + 1];
      const b = frameData[i * 4 + 2];

      floatData[i] = ((r / 255.0) - this.MEAN[0]) / this.STD[0];                 // Red channel
      floatData[channelSize + i] = ((g / 255.0) - this.MEAN[1]) / this.STD[1];   // Green channel
      floatData[2 * channelSize + i] = ((b / 255.0) - this.MEAN[2]) / this.STD[2]; // Blue channel
    }

    return new ort.Tensor('float32', floatData, [1, 3, this.INPUT_WIDTH, this.INPUT_HEIGHT]);
  }

  softmax(logits) {
    let maxLogit = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxLogit) maxLogit = logits[i];
    }

    const expValues = new Float32Array(logits.length);
    let sumExp = 0.0;

    for (let i = 0; i < logits.length; i++) {
      expValues[i] = Math.exp(logits[i] - maxLogit);
      sumExp += expValues[i];
    }

    for (let i = 0; i < logits.length; i++) {
      expValues[i] /= sumExp;
    }

    return expValues;
  }

  /* ---------------- INFERENCE LOOP & SLIDING WINDOW ---------------- */

  predictLoop() {
    const step = async () => {
      if (this.isRunning && this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        await this.processFrame();
      }
      setTimeout(step, this.INFERENCE_INTERVAL_MS);
    };
    step();
  }

  async processFrame() {
    try {
      const tensor = this.preprocessFrame();
      const results = await this.session.run({ [this.inputName]: tensor });
      const logits = results[this.outputName].data;
      const probabilities = this.softmax(logits);

      // Map probabilities to indexed labels
      const predictions = this.classes.map((className, index) => ({
        className: String(className),
        probability: probabilities[index]
      }));

      // Sort descending
      predictions.sort((a, b) => b.probability - a.probability);
      const top1 = predictions[0];
      const top2 = predictions[1] || { className: 'none', probability: 0.0 };

      const top1Prob = top1.probability;
      const top2Prob = top2.probability;
      const margin = top1Prob - top2Prob;
      const isBackground = top1.className.toLowerCase() === 'background';

      // Three-Tier Entry Gate Check
      const isValid =
        top1Prob >= this.MIN_CONFIDENCE_THRESHOLD &&
        margin >= this.CONFIDENCE_MARGIN &&
        !isBackground;

      const frameLabel = isValid ? top1.className : 'noise';

      // Sliding Window Maintenance (N = 7)
      this.predictionHistory.push(frameLabel);
      if (this.predictionHistory.length > this.WINDOW_SIZE) {
        this.predictionHistory.shift();
      }

      // Majority Consensus Count
      const counts = {};
      let consensusCandidate = null;
      let maxVotes = 0;

      for (const label of this.predictionHistory) {
        counts[label] = (counts[label] || 0) + 1;
        if (label !== 'noise' && counts[label] > maxVotes) {
          maxVotes = counts[label];
          consensusCandidate = label;
        }
      }

      this.renderTelemetry(top1, top2, maxVotes, consensusCandidate);

      // Supermajority Evaluation (5/7 votes)
      if (consensusCandidate && maxVotes >= this.MIN_CONSISTENT_FRAMES) {
        this.lastActiveVisionTime = Date.now();
        this.evaluateConsensus(consensusCandidate);
      } else {
        this.evaluateNoiseDrain();
      }
    } catch (err) {
      console.warn("Inference cycle skipped:", err);
    }
  }

  evaluateConsensus(candidateLabel) {
    const parsedDenomination = this.extractDenomination(candidateLabel);
    if (!parsedDenomination) return;

    const now = Date.now();
    const isNewNote = parsedDenomination !== this.currentAnnouncedNote;
    const cooldownElapsed = (now - this.lastAnnouncementTime) >= this.ANNOUNCE_COOLDOWN_MS;

    if (isNewNote || cooldownElapsed) {
      this.currentAnnouncedNote = parsedDenomination;
      this.lastAnnouncementTime = now;

      if (this.isTallyMode) {
        this.sessionTotal += parsedDenomination;
        if (this.displayTally) {
          this.displayTally.textContent = `₹${this.sessionTotal}`;
        }
      }

      if (this.displayNote) {
        this.displayNote.textContent = `₹${parsedDenomination}`;
      }
      if (this.guidanceTip) {
        this.guidanceTip.textContent = `Identified: ₹${parsedDenomination}`;
      }

      this.triggerHaptic(this.HAPTIC_PROFILES[parsedDenomination] || [200]);

      const noteWord = this.WORDS_MAP[parsedDenomination] || parsedDenomination;
      let announcement = `${noteWord} rupees.`;
      if (this.isTallyMode) {
        announcement = `${noteWord} rupees. Running total: ${this.sessionTotal} rupees.`;
      }

      this.speakResult(announcement, true);

      // Reset buffer to prevent multiple fires within the same frame burst
      this.predictionHistory = [];
    }
  }

  evaluateNoiseDrain() {
    const now = Date.now();
    if (this.currentAnnouncedNote !== null && (now - this.lastActiveVisionTime) > this.NOISE_RESET_WINDOW_MS) {
      this.currentAnnouncedNote = null;
      if (this.guidanceTip) {
        this.guidanceTip.textContent = "Point camera at a rupee note";
      }
    }
  }

  extractDenomination(className) {
    const match = className.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  renderTelemetry(top1, top2, votes, candidate) {
    if (!this.debugDisplay) return;
    const p1 = (top1.probability * 100).toFixed(0);
    const p2 = (top2.probability * 100).toFixed(0);
    const cand = candidate || 'None';
    this.debugDisplay.textContent =
      `Top: ₹${top1.className} (${p1}%) | 2nd: ₹${top2.className} (${p2}%) | Votes: ${votes}/${this.WINDOW_SIZE} (${cand})`;
  }

  /* ---------------- SPEECH & HAPTICS ---------------- */

  speakResult(text, cancelOngoing = false) {
    if (!('speechSynthesis' in window)) return;

    if (cancelOngoing) {
      window.speechSynthesis.cancel();
    }

    if (this.announcer) {
      this.announcer.textContent = '';
      setTimeout(() => {
        this.announcer.textContent = text;
      }, 20);
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 1.05;

    const voices = window.speechSynthesis.getVoices();
    const inVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang.startsWith('en'));
    if (inVoice) {
      utterance.voice = inVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  triggerHaptic(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Safe vendor policy fallback
      }
    }
  }

  /* ---------------- GESTURE CONTROLS ---------------- */

  bindGestures() {
    this.surface.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        clearTimeout(this.singleTapTimer);
        clearTimeout(this.longPressTimer);
        this.resetTally();
        return;
      }

      if (e.touches.length === 1) {
        this.touchStartTime = Date.now();
        this.longPressTimer = setTimeout(() => {
          this.resetTally();
        }, 1500);
      }
    }, { passive: false });

    this.surface.addEventListener('touchend', (e) => {
      clearTimeout(this.longPressTimer);

      if (Date.now() - this.touchStartTime > 600) return;
      if (e.touches.length > 0) return;

      const currentTime = Date.now();
      const tapGap = currentTime - this.lastTapTime;

      if (tapGap < 300 && tapGap > 0) {
        clearTimeout(this.singleTapTimer);
        this.toggleTorch();
      } else {
        this.singleTapTimer = setTimeout(() => {
          this.repeatAnnouncement();
        }, 300);
      }

      this.lastTapTime = currentTime;
    });
  }

  bindAccessibleButtons() {
    const btnRepeat = document.getElementById('sr-btn-repeat');
    const btnTorch = document.getElementById('sr-btn-torch');
    const btnReset = document.getElementById('sr-btn-reset');

    if (btnRepeat) btnRepeat.addEventListener('click', () => this.repeatAnnouncement());
    if (btnTorch) btnTorch.addEventListener('click', () => this.toggleTorch());
    if (btnReset) btnReset.addEventListener('click', () => this.resetTally());
  }

  repeatAnnouncement() {
    this.triggerHaptic([60]);
    if (this.currentAnnouncedNote) {
      const word = this.WORDS_MAP[this.currentAnnouncedNote] || this.currentAnnouncedNote;
      let phrase = `${word} rupees.`;
      if (this.isTallyMode) {
        phrase = `Last note: ${word} rupees. Session total: ${this.sessionTotal} rupees.`;
      }
      this.speakResult(phrase, true);
    } else {
      const phrase = this.isTallyMode
        ? `No note scanned yet. Session total: ${this.sessionTotal} rupees.`
        : "No note scanned yet.";
      this.speakResult(phrase, true);
    }
  }

  resetTally() {
    this.sessionTotal = 0;
    this.currentAnnouncedNote = null;
    this.predictionHistory = [];

    if (this.displayTally) this.displayTally.textContent = "₹0";
    if (this.displayNote) this.displayNote.textContent = "READY";
    if (this.guidanceTip) this.guidanceTip.textContent = "Tally reset to zero";

    this.triggerHaptic(this.HAPTIC_PROFILES.reset);
    this.speakResult("Tally reset to zero.", true);
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then(reg => console.log('DivyaDrishti SW active with scope:', reg.scope))
          .catch(err => console.error('SW registration failed:', err));
      });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.identifier = new IndianBanknoteIdentifier();
});