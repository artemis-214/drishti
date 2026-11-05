/**
 * Indian Banknote Identifier (Identification Only)
 * High-Contrast Accessible PWA with Teachable Machine Vision & Multimodal Feedback
 */

class IndianBanknoteIdentifier {
  constructor() {
    // Relative path safe for GitHub Pages deployments
    this.MODEL_PATH = './model/';

    // DOM References
    this.video = document.getElementById('camera-stream');
    this.announcer = document.getElementById('announcer');
    this.displayNote = document.getElementById('display-note');
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
    this.isRunning = false;

    // Detection State
    this.lastDetectedDenomination = null;
    this.lastConfirmedTime = 0;

    // Thresholds: Lowered to 0.70 to reliably register bills in casual lighting
    this.CONFIDENCE_THRESHOLD = 0.70;
    this.REPEAT_WINDOW_MS = 2500; // Debounce window for identical note held in front
    this.INFERENCE_INTERVAL_MS = 250; // Throttled inference loop (~4 FPS)

    // Haptic vibration profiles (ms)
    this.HAPTIC_PROFILES = {
      10: [100],
      20: [100, 50, 100],
      50: [300],
      100: [300, 100, 100],
      200: [300, 100, 300],
      500: [300, 100, 300, 100, 300],
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

    this.bindInit();
  }

  bindInit() {
    this.btnGateStart.addEventListener('click', () => this.unlockAndStart());
    this.registerServiceWorker();
  }

  async unlockAndStart() {
    this.gateOverlay.classList.add('hidden');
    this.speak("Starting camera and loading model.", true);

    try {
      await Promise.all([this.initCamera(), this.loadModel()]);
      this.bindGestures();
      this.bindAccessibleButtons();
      this.isRunning = true;
      this.speak("Scanner ready. Center banknote in front of camera.", true);
      this.runInferenceLoop();
    } catch (err) {
      console.error("Initialization error:", err);
      this.guidanceTip.textContent = "Error: Check camera & model files";
      this.speak("Initialization failed. Please check camera permissions and model files.", true);
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
      const predictions = await this.model.predict(this.video);
      
      // Sort to evaluate highest confidence class
      predictions.sort((a, b) => b.probability - a.probability);
      const top = predictions[0];

      // Real-time HUD feedback showing live detection & certainty
      const pct = (top.probability * 100).toFixed(0);
      this.guidanceTip.textContent = `Scanning: ${top.className} (${pct}%)`;

      // Ignore background or predictions below confidence threshold
      if (top.className.toLowerCase().includes("background") || top.probability < this.CONFIDENCE_THRESHOLD) {
        return;
      }

      // Robust number extraction (matches "500_rupees", "₹500", "500", etc.)
      const match = top.className.match(/\d+/);
      if (!match) return;

      const denomination = parseInt(match[0], 10);
      this.handleConfirmedDetection(denomination);
    } catch (err) {
      console.warn("Frame inference cycle skipped:", err);
    }
  }

  handleConfirmedDetection(denomination) {
    const now = Date.now();
    const isSameBill = denomination === this.lastDetectedDenomination;
    const isDebounced = (now - this.lastConfirmedTime) < this.REPEAT_WINDOW_MS;

    // Suppress continuous speech while holding the same bill still
    if (isSameBill && isDebounced) {
      return;
    }

    this.lastDetectedDenomination = denomination;
    this.lastConfirmedTime = now;

    // Update UI
    this.displayNote.textContent = `₹${denomination}`;
    this.guidanceTip.textContent = `Identified: ₹${denomination}`;

    // Multimodal triggers
    this.vibrate(this.HAPTIC_PROFILES[denomination] || [200]);

    const word = this.WORDS_MAP[denomination] || denomination;
    const announcement = `${word} rupees.`;
    this.speak(announcement, true);
  }

  /* ---------------- SPEECH & HAPTICS ---------------- */

  speak(text, cancelCurrent = false) {
    if (!('speechSynthesis' in window)) return;

    if (cancelCurrent) {
      window.speechSynthesis.cancel();
    }

    // Mirror to WCAG assertive live region for TalkBack / VoiceOver
    this.announcer.textContent = '';
    setTimeout(() => {
      this.announcer.textContent = text;
    }, 20);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 1.05;

    const voices = window.speechSynthesis.getVoices();
    const inVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang.startsWith('en'));
    if (inVoice) utterance.voice = inVoice;

    window.speechSynthesis.speak(utterance);
  }

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Safe catch for vendor restriction policies
      }
    }
  }

  /* ---------------- GESTURE & ACCESSIBILITY HANDLERS ---------------- */

  bindGestures() {
    this.surface.addEventListener('touchend', (e) => {
      if (e.touches.length > 0) return;

      const currentTime = Date.now();
      const tapGap = currentTime - this.lastTapTime;

      if (tapGap < 300 && tapGap > 0) {
        // Double Tap: Flashlight Toggle
        clearTimeout(this.singleTapTimer);
        this.toggleTorch();
      } else {
        // Single Tap: Repeat Current Note
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
  }

  repeatAnnouncement() {
    this.vibrate([60]);
    if (this.lastDetectedDenomination) {
      const word = this.WORDS_MAP[this.lastDetectedDenomination] || this.lastDetectedDenomination;
      this.speak(`${word} rupees.`, true);
    } else {
      this.speak("No banknote identified yet.", true);
    }
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

window.addEventListener('DOMContentLoaded', () => {
  window.identifier = new IndianBanknoteIdentifier();
});