/**
 * Indian Banknote Identifier
 * Accessible PWA with Teachable Machine Vision, Multi-Sense Haptics, and Web Speech
 */

class IndianBanknoteIdentifier {
  constructor() {
    // Relative path safe for GitHub Pages deployments
    this.MODEL_PATH = './model/';

    // DOM References
    this.video = document.getElementById('camera-stream');
    this.announcer = document.getElementById('announcer');
    this.displayNote = document.getElementById('display-note');
    this.displayTally = document.getElementById('display-tally');
    this.badgeMode = document.getElementById('badge-mode');
    this.badgeTorch = document.getElementById('badge-torch');
    this.guidanceTip = document.getElementById('guidance-tip');
    this.surface = document.getElementById('app-surface');
    this.gateOverlay = document.getElementById('gate-overlay');
    this.btnGateStart = document.getElementById('btn-gate-start');

    // Model and Stream State
    this.model = null;
    this.stream = null;
    this.videoTrack = null;
    this.isTorchOn = false;
    this.isTallyMode = true; // Defaults to continuous tallying
    this.isRunning = false;

    // Financial State
    this.sessionTotal = 0;
    this.lastDetectedDenomination = null;
    this.lastSpokenText = '';
    this.lastConfirmedTime = 0;

    // Detection Thresholds
    this.CONFIDENCE_THRESHOLD = 0.65;
    this.REPEAT_WINDOW_MS = 2500; // 2.5 seconds debounce for the same bill
    this.INFERENCE_INTERVAL_MS = 250; // Throttled inference loop

    // Haptic vibration profiles (ms)
    this.HAPTIC_PROFILES = {
      10: [100],
      20: [100, 50, 100],
      50: [300],
      100: [300, 100, 100],
      200: [300, 100, 300],
      500: [300, 100, 300, 100, 300],
      reset: [80, 50, 80, 50, 80],
      torch: [60]
    };

    // Words lookup for clean screen reader/speech articulation
    this.WORDS_MAP = {
      10: "Ten",
      20: "Twenty",
      50: "Fifty",
      100: "One hundred",
      200: "Two hundred",
      500: "Five hundred"
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

    // Unlock AudioContext & SpeechSynthesis on physical user interaction
    this.speak("Starting camera and loading currency model.", true);

    try {
      await Promise.all([this.initCamera(), this.loadModel()]);
      this.bindGestures();
      this.bindAccessibleButtons();
      this.isRunning = true;
      this.speak("Scanner ready. Point camera at banknote.", true);
      this.runInferenceLoop();
    } catch (err) {
      console.error("Initialization error:", err);
      this.speak("System error. Please verify camera permissions and reload.", true);
    }
  }

  /* ---------------- HARDWARE SUBSYSTEMS ---------------- */

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

  async loadModel() {
    const modelURL = `${this.MODEL_PATH}model.json`;
    const metadataURL = `${this.MODEL_PATH}metadata.json`;

    this.model = await tmImage.load(modelURL, metadataURL);
  }

  async toggleTorch() {
    if (!this.videoTrack) return;

    try {
      const capabilities = this.videoTrack.getCapabilities ? this.videoTrack.getCapabilities() : {};
      if (!capabilities.torch) {
        this.speak("Torch not supported on this device.", true);
        return;
      }

      this.isTorchOn = !this.isTorchOn;
      await this.videoTrack.applyConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });

      this.vibrate(this.HAPTIC_PROFILES.torch);
      this.badgeTorch.textContent = `TORCH: ${this.isTorchOn ? 'ON' : 'OFF'}`;
      this.badgeTorch.classList.toggle('badge-dim', !this.isTorchOn);
      this.speak(`Flashlight ${this.isTorchOn ? 'on' : 'off'}.`, true);
    } catch (e) {
      this.speak("Unable to toggle flashlight.", true);
    }
  }

  /* ---------------- INFERENCE & PREDICTION ---------------- */

  runInferenceLoop() {
    const step = async () => {
      if (this.isRunning && this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        await this.predictFrame();
      }
      setTimeout(step, this.INFERENCE_INTERVAL_MS);
    };
    step();
  }

  async predictFrame() {
  try {
    if (!this.model) {
      this.guidanceTip.textContent = "Model not loaded!";
      return;
    }

    const predictions = await this.model.predict(this.video);
    
    // Sort predictions highest to lowest
    predictions.sort((a, b) => b.probability - a.probability);
    const top = predictions[0];

    // Debug readout: display highest class & score in real-time
    this.guidanceTip.textContent = `${top.className}: ${(top.probability * 100).toFixed(0)}%`;

    if (top.className === "background" || top.probability < this.CONFIDENCE_THRESHOLD) {
      return;
    }

    // Handle label formats (e.g., "500_rupees", "₹500", "500", "500 Rupees")
    const match = top.className.match(/\d+/);
    if (!match) return;

    const parsedDenomination = parseInt(match[0], 10);
    this.handleConfirmedDetection(parsedDenomination);

  } catch (err) {
    console.error("Prediction error:", err);
    this.guidanceTip.textContent = "Inference error";
  }
}

  handleConfirmedDetection(denomination) {
    const now = Date.now();
    const isSameBill = denomination === this.lastDetectedDenomination;
    const isDebounced = (now - this.lastConfirmedTime) < this.REPEAT_WINDOW_MS;

    // Suppress duplicate triggers for an identical bill held steady
    if (isSameBill && isDebounced) {
      return;
    }

    this.lastDetectedDenomination = denomination;
    this.lastConfirmedTime = now;

    // Financial running tally aggregation
    this.sessionTotal += denomination;

    // Update visuals
    this.displayNote.textContent = `₹${denomination}`;
    this.displayTally.textContent = `₹${this.sessionTotal}`;
    this.guidanceTip.textContent = `Detected ₹${denomination}`;

    // Sensory Outputs
    this.vibrate(this.HAPTIC_PROFILES[denomination] || [200]);

    const denominationText = `${this.WORDS_MAP[denomination] || denomination} rupees`;
    let announcement = "";

    if (this.isTallyMode) {
      announcement = `${denominationText}. Running total: ${this.sessionTotal} rupees.`;
    } else {
      announcement = `${denominationText}.`;
    }

    this.speak(announcement, true);
  }

  /* ---------------- SPEECH & HAPTICS ---------------- */

  speak(text, cancelCurrent = false) {
    if (!('speechSynthesis' in window)) return;

    if (cancelCurrent) {
      window.speechSynthesis.cancel();
    }

    // Mirror to WCAG assertive region for active TalkBack / VoiceOver listeners
    this.announcer.textContent = '';
    setTimeout(() => {
      this.announcer.textContent = text;
    }, 20);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 1.05;

    // Favor English (India) voices when indexed
    const voices = window.speechSynthesis.getVoices();
    const localizedVoice = voices.find(v => v.lang === 'en-IN');
    if (localizedVoice) utterance.voice = localizedVoice;

    this.lastSpokenText = text;
    window.speechSynthesis.speak(utterance);
  }

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Safe fallback for restricted permissions
      }
    }
  }

  /* ---------------- GESTURE & ACCESSIBILITY HANDLERS ---------------- */

  bindGestures() {
    this.surface.addEventListener('touchstart', (e) => {
      // 1. Two-finger tap detection (Immediate reset)
      if (e.touches.length === 2) {
        e.preventDefault();
        clearTimeout(this.singleTapTimer);
        clearTimeout(this.longPressTimer);
        this.resetTally();
        return;
      }

      // 2. Long Press fallback detection (1.5 seconds)
      if (e.touches.length === 1) {
        this.touchStartTime = Date.now();
        this.longPressTimer = setTimeout(() => {
          this.resetTally();
        }, 1500);
      }
    }, { passive: false });

    this.surface.addEventListener('touchend', (e) => {
      clearTimeout(this.longPressTimer);

      // Do not process single/double tap if touch was held past 600ms
      if (Date.now() - this.touchStartTime > 600) {
        return;
      }

      if (e.touches.length > 0) return;

      const currentTime = Date.now();
      const tapGap = currentTime - this.lastTapTime;

      if (tapGap < 300 && tapGap > 0) {
        // Double tap: Torch toggle
        clearTimeout(this.singleTapTimer);
        this.toggleTorch();
      } else {
        // Single tap: Schedule repeat
        this.singleTapTimer = setTimeout(() => {
          this.repeatAnnouncement();
        }, 300);
      }

      this.lastTapTime = currentTime;
    });
  }

  bindAccessibleButtons() {
    document.getElementById('sr-btn-repeat').addEventListener('click', () => this.repeatAnnouncement());
    document.getElementById('sr-btn-torch').addEventListener('click', () => this.toggleTorch());
    document.getElementById('sr-btn-reset').addEventListener('click', () => this.resetTally());
    document.getElementById('sr-btn-mode').addEventListener('click', () => this.toggleMode());
  }

  repeatAnnouncement() {
    this.vibrate([60]);
    if (this.lastDetectedDenomination) {
      const phrase = `Last note: ${this.WORDS_MAP[this.lastDetectedDenomination] || this.lastDetectedDenomination} rupees. Session total: ${this.sessionTotal} rupees.`;
      this.speak(phrase, true);
    } else {
      this.speak(`No note scanned yet. Session total: ${this.sessionTotal} rupees.`, true);
    }
  }

  resetTally() {
    this.sessionTotal = 0;
    this.lastDetectedDenomination = null;
    this.displayTally.textContent = "₹0";
    this.displayNote.textContent = "READY";
    this.guidanceTip.textContent = "Tally reset to zero";

    this.vibrate(this.HAPTIC_PROFILES.reset);
    this.speak("Tally reset to zero.", true);
  }

  toggleMode() {
    this.isTallyMode = !this.isTallyMode;
    this.badgeMode.textContent = this.isTallyMode ? "TALLY MODE" : "SINGLE SCAN";
    this.speak(`Switched to ${this.isTallyMode ? "Tally Mode" : "Single Scan Mode"}.`, true);
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        // Relative scope for GitHub Pages compatibility
        navigator.serviceWorker.register('./sw.js')
          .then(reg => console.log('DivyaDrishti SW registered with scope:', reg.scope))
          .catch(err => console.error('SW registration failed:', err));
      });
    }
  }
}

// Instantiate engine when DOM is parsed
window.addEventListener('DOMContentLoaded', () => {
  window.identifier = new IndianBanknoteIdentifier();
});