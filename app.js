class BanknoteIdentifier {
  constructor() {
    this.video = document.getElementById('camera-stream');
    this.canvas = document.getElementById('inference-canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.srLive = document.getElementById('sr-live-region');
    this.srStatus = document.getElementById('sr-status-region');
    this.detectedValEl = document.getElementById('detected-val');
    this.tallyValEl = document.getElementById('tally-val');
    this.guidanceTextEl = document.getElementById('guidance-text');
    this.torchBadge = document.getElementById('torch-badge');
    this.viewport = document.getElementById('app-viewport');

    // State
    this.stream = null;
    this.track = null;
    this.isTorchOn = false;
    this.runningTotal = 0;
    this.lastDetectedDenomination = null;
    this.consecutiveDetections = 0;
    this.activePrediction = null;
    this.isProcessingFrame = false;
    this.lastSpokenText = '';
    this.lastSpeechTime = 0;

    // Supported Indian Banknote Denominations (INR)
    this.DENOMINATIONS = [10, 20, 50, 100, 200, 500];

    // Haptic Patterns (ms vibration vs rest)
    this.HAPTIC_PATTERNS = {
      10: [100],
      20: [150, 80, 150],
      50: [300],
      100: [300, 100, 100],
      200: [300, 100, 200, 100],
      500: [300, 100, 300, 100, 300],
      reset: [100, 50, 100, 50, 100],
      torch: [70],
      guidance: [40]
    };

    // Web Audio Infrastructure
    this.audioCtx = null;
    this.pannerNode = null;

    // Gesture Tracking
    this.lastTapTime = 0;
    this.singleTapTimeout = null;

    this.init();
  }

  async init() {
    this.bindEvents();
    this.registerServiceWorker();
    await this.initCamera();
    this.startInferenceLoop();
  }

  /* AUDIO SUBSYSTEM  */

  initAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  playSpatialTick(xNormalized) {
    this.initAudioContext();

    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    const panner = this.audioCtx.createStereoPanner ? this.audioCtx.createStereoPanner() : null;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, this.audioCtx.currentTime); // High tick: 880Hz (A5)

    gain.gain.setValueAtTime(0.001, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, this.audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.08);

    if (panner) {
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, xNormalized)), this.audioCtx.currentTime);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.audioCtx.destination);
    } else {
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
    }

    osc.start();
    osc.stop(this.audioCtx.currentTime + 0.09);
  }

  playConfirmationChime() {
    this.initAudioContext();
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 triad
    notes.forEach((freq, idx) => {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      const startTime = this.audioCtx.currentTime + (idx * 0.07);

      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.25, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.25);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.26);
    });
  }

  /*   SPEECH & HAPTICS   */

  speak(text, priority = false) {
    if (!('speechSynthesis' in window)) return;

    const now = Date.now();
    // Debounce non-priority announcements by 1200ms
    if (!priority && text === this.lastSpokenText && (now - this.lastSpeechTime) < 1200) {
      return;
    }

    if (priority) {
      window.speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    // Prioritize English (India) or Hindi (India) voices
    const voices = window.speechSynthesis.getVoices();
    const inVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang === 'hi-IN');
    if (inVoice) {
      utterance.voice = inVoice;
    }

    this.lastSpokenText = text;
    this.lastSpeechTime = now;

    // Trigger visual/aria screen reader live region synchronously
    this.srLive.textContent = text;
    window.speechSynthesis.speak(utterance);
  }

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Suppress vendor restriction errors
      }
    }
  }

  /*   CAMERA & HARDWARE CONTROLS   */

  async initCamera() {
    try {
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: { ideal: 'continuous' }
        }
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      this.track = this.stream.getVideoTracks()[0];

      await this.video.play();
      this.speak("Camera active. Present banknote to scan.", true);
    } catch (err) {
      const errorMsg = "Camera access denied. Please grant permission to identify banknotes.";
      this.guidanceTextEl.textContent = errorMsg;
      this.speak(errorMsg, true);
    }
  }

  async toggleTorch() {
    if (!this.track) return;

    try {
      const capabilities = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (!capabilities.torch) {
        this.speak("Flashlight not available on this device", true);
        return;
      }

      this.isTorchOn = !this.isTorchOn;
      await this.track.applyConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });

      this.vibrate(this.HAPTIC_PATTERNS.torch);
      this.torchBadge.textContent = `TORCH: ${this.isTorchOn ? 'ON' : 'OFF'}`;
      this.torchBadge.classList.toggle('active', this.isTorchOn);
      this.speak(`Flashlight ${this.isTorchOn ? 'On' : 'Off'}`, true);
    } catch (e) {
      this.speak("Unable to control flashlight", true);
    }
  }

  /*   INFERENCE & SPATIAL GUIDANCE   */

  startInferenceLoop() {
    const loop = async () => {
      if (this.video.readyState === this.video.HAVE_ENOUGH_DATA && !this.isProcessingFrame) {
        this.isProcessingFrame = true;
        await this.processVideoFrame();
        this.isProcessingFrame = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async processVideoFrame() {
    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    const frameData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const result = await this.runInference(frameData);

    if (result && result.detected) {
      this.evaluateSpatialFraming(result.boundingBox);
      this.handleDetectionSuccess(result.denomination, result.confidence);
    } else {
      this.consecutiveDetections = 0;
      this.activePrediction = null;
    }
  }

  /**
   * Model Hook: Plug-and-play TensorFlow.js / Custom CNN inference interface
   */
  async runInference(imageData) {
    /*
     * Placeholder for production model inference:
     * e.g., const tensor = tf.browser.fromPixels(imageData).resizeNearestNeighbor([224, 224]).toFloat().expandDims();
     * const predictions = await model.predict(tensor).data();
     *
     * Simulating a structured inference result for production architecture:
     */
    return new Promise(resolve => {
      // Stub engine hook simulating intermittent frame recognition
      resolve(null);
    });
  }

  evaluateSpatialFraming(box) {
    if (!box) return;

    // Bounding Box format: { xMin, yMin, width, height } normalized [0, 1]
    const centerX = box.xMin + (box.width / 2);
    const area = box.width * box.height;

    // 1. Proximity Guidance
    if (area > 0.85) {
      this.guidanceTextEl.textContent = "Move note back";
      this.speak("Move back");
      return;
    } else if (area < 0.15) {
      this.guidanceTextEl.textContent = "Bring note closer";
      return;
    }

    // 2. Spatial Horizontal Alignment via Stereo Tick
    if (centerX < 0.35) {
      this.guidanceTextEl.textContent = "Move right";
      this.playSpatialTick(-0.85); // Left channel tick
    } else if (centerX > 0.65) {
      this.guidanceTextEl.textContent = "Move left";
      this.playSpatialTick(0.85); // Right channel tick
    } else {
      this.guidanceTextEl.textContent = "Centered";
    }
  }

  handleDetectionSuccess(denomination, confidence) {
    if (confidence < 0.80) return;

    if (this.activePrediction === denomination) {
      this.consecutiveDetections++;
    } else {
      this.activePrediction = denomination;
      this.consecutiveDetections = 1;
    }

    // 3 consecutive frames required for stable confirmation
    if (this.consecutiveDetections === 3) {
      this.confirmDenomination(denomination);
    }
  }

  confirmDenomination(val) {
    this.lastDetectedDenomination = val;
    this.runningTotal += val;

    // Multi-Sense Dispatch
    this.detectedValEl.textContent = `₹${val}`;
    this.tallyValEl.textContent = `₹${this.runningTotal}`;

    this.playConfirmationChime();
    this.vibrate(this.HAPTIC_PATTERNS[val] || [200]);

    const announcement = `${val} rupees. Total: ${this.runningTotal} rupees.`;
    this.speak(announcement, true);
  }

  /*   GESTURE INTERACTIONS   */

  bindEvents() {
    // Gestures on Full-Screen Touch Area
    this.viewport.addEventListener('touchstart', (e) => {
      this.initAudioContext();

      // Multi-Touch: Two-Finger Tap resets session total
      if (e.touches.length === 2) {
        e.preventDefault();
        this.resetTally();
        return;
      }

      // Single/Double Tap processing on 1-finger release
    }, { passive: false });

    this.viewport.addEventListener('touchend', (e) => {
      if (e.touches.length > 0) return; // Wait until all fingers lift

      const currentTime = Date.now();
      const tapGap = currentTime - this.lastTapTime;

      if (tapGap < 300 && tapGap > 0) {
        // Double Tap Detected
        clearTimeout(this.singleTapTimeout);
        this.toggleTorch();
      } else {
        // Schedule Single Tap
        this.singleTapTimeout = setTimeout(() => {
          this.repeatLastDenomination();
        }, 300);
      }

      this.lastTapTime = currentTime;
    });

    // Keyboard Fallback Bindings
    document.getElementById('btn-repeat').addEventListener('click', () => this.repeatLastDenomination());
    document.getElementById('btn-torch').addEventListener('click', () => this.toggleTorch());
    document.getElementById('btn-reset').addEventListener('click', () => this.resetTally());
  }

  repeatLastDenomination() {
    if (this.lastDetectedDenomination) {
      this.vibrate([80]);
      this.speak(`Last note: ${this.lastDetectedDenomination} rupees. Session total: ${this.runningTotal} rupees.`, true);
    } else {
      this.speak(`No banknote detected yet. Current total: ${this.runningTotal} rupees.`, true);
    }
  }

  resetTally() {
    this.runningTotal = 0;
    this.lastDetectedDenomination = null;
    this.tallyValEl.textContent = "₹0";
    this.detectedValEl.textContent = "READY";
    this.guidanceTextEl.textContent = "Tally reset to zero";

    this.vibrate(this.HAPTIC_PATTERNS.reset);
    this.speak("Tally cleared. Total zero rupees.", true);
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .catch((err) => console.error('SW registration failed:', err));
      });
    }
  }
}

// Bootstrap once DOM loads
window.addEventListener('DOMContentLoaded', () => {
  window.app = new BanknoteIdentifier();
});