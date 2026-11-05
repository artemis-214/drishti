/**
 * Indian Banknote Identifier - app.js
 * Hardened Classification Pipeline: Temporal Consensus, Margin Filtering & Debounce
 *
 * Architecture Highlights:
 * 1. Top-2 Delta Margin Validation: Drops frames where the model hesitates between two classes.
 * 2. Rolling History Window (N = 7): Smooths single-frame camera exposure and sensor noise.
 * 3. Supermajority Consensus (K = 5/7): Guarantees spatial and temporal agreement before announcement.
 * 4. Noise Drain Reset: Detects empty scene/background to allow clean re-scans of identical notes.
 */

class IndianBanknoteIdentifier {
  constructor() {
    // Relative path safe for GitHub Pages deployments
    this.MODEL_PATH = './model/';

    // DOM Elements
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

    // Create or locate the telemetry debug element
    this.debugDisplay = document.getElementById('debug-display');
    if (!this.debugDisplay) {
      this.debugDisplay = document.createElement('div');
      this.debugDisplay.id = 'debug-display';
      this.debugDisplay.className = 'debug-telemetry';
      this.debugDisplay.setAttribute('aria-hidden', 'true'); // Prevents SR clutter
      const hudBottom = document.querySelector('.hud-bottom');
      if (hudBottom) {
        hudBottom.appendChild(this.debugDisplay);
      }
    }

    // Hardware & Runtime State
    this.model = null;
    this.stream = null;
    this.videoTrack = null;
    this.isTorchOn = false;
    this.isTallyMode = Boolean(this.displayTally); // Auto-detect tally UI presence
    this.isRunning = false;

    // Financial State
    this.sessionTotal = 0;
    this.currentAnnouncedNote = null;
    this.lastAnnouncementTime = 0;
    this.lastActiveVisionTime = Date.now();

    // ==========================================
    // STABILITY & TEMPORAL FILTER CONFIGURATION
    // ==========================================
    this.WINDOW_SIZE = 7;             // N = 7 frames buffer
    this.MIN_CONSISTENT_FRAMES = 5;   // Consensus threshold (5/7 supermajority)
    this.MIN_CONFIDENCE_THRESHOLD = 0.82; // Absolute top-1 certainty cutoff
    this.CONFIDENCE_MARGIN = 0.25;    // (top1 - top2) delta margin requirement
    this.ANNOUNCE_COOLDOWN_MS = 2800; // Cooldown before re-announcing identical note
    this.NOISE_RESET_WINDOW_MS = 3000; // Inactivity window to forget previous note
    this.INFERENCE_INTERVAL_MS = 140; // ~7 FPS sampling rate for fast response

    // Rolling temporal sliding window
    this.predictionHistory = [];

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

    // Clean pronunciation map
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
    this.speakResult("Starting camera and initializing classifier.", true);

    try {
      await Promise.all([this.initCamera(), this.loadModel()]);
      this.bindGestures();
      this.bindAccessibleButtons();
      this.isRunning = true;
      this.speakResult("Scanner active. Hold banknote steady.", true);
      this.predictLoop();
    } catch (err) {
      console.error("Initialization error:", err);
      if (this.guidanceTip) {
        this.guidanceTip.textContent = "Error loading camera or model";
      }
      this.speakResult("Failed to initialize scanner. Check camera permissions and reload.", true);
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
      const caps = this.videoTrack.getCapabilities ? this.videoTrack.getCapabilities() : {};
      if (!caps.torch) {
        this.speakResult("Flashlight not supported on this device.", true);
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
    } catch (e) {
      this.speakResult("Unable to toggle flashlight.", true);
    }
  }

  /* ---------------- INFERENCE & STABILIZATION ENGINE ---------------- */

  predictLoop() {
    const step = async () => {
      if (this.isRunning && this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        await this.processInferenceFrame();
      }
      setTimeout(step, this.INFERENCE_INTERVAL_MS);
    };
    step();
  }

  async processInferenceFrame() {
    try {
      const rawPredictions = await this.model.predict(this.video);

      // Sort descending to isolate top-1 and top-2 contenders
      rawPredictions.sort((a, b) => b.probability - a.probability);
      const top1 = rawPredictions[0];
      const top2 = rawPredictions[1] || { className: "none", probability: 0.0 };

      const top1Prob = top1.probability;
      const top2Prob = top2.probability;
      const margin = top1Prob - top2Prob;
      const isBackground = top1.className.toLowerCase().includes("background");

      // ==========================================
      // REQUIREMENT 1: THREE-TIER ENTRY GATE
      // ==========================================
      const isFrameValid =
        top1Prob >= this.MIN_CONFIDENCE_THRESHOLD &&
        margin >= this.CONFIDENCE_MARGIN &&
        !isBackground;

      const frameLabel = isFrameValid ? top1.className : "noise";

      // Append candidate to rolling window and maintain buffer size N = 7
      this.predictionHistory.push(frameLabel);
      if (this.predictionHistory.length > this.WINDOW_SIZE) {
        this.predictionHistory.shift();
      }

      // ==========================================
      // REQUIREMENT 2: MAJORITY VOTING CONSENSUS
      // ==========================================
      const counts = {};
      let consensusCandidate = null;
      let maxVotes = 0;

      for (const label of this.predictionHistory) {
        counts[label] = (counts[label] || 0) + 1;
        if (label !== "noise" && counts[label] > maxVotes) {
          maxVotes = counts[label];
          consensusCandidate = label;
        }
      }

      // Update Visual Telemetry (Does not trigger aria-live)
      this.renderTelemetry(top1, top2, maxVotes, consensusCandidate);

      // Check if candidate met supermajority (K >= 5 / 7)
      if (consensusCandidate && maxVotes >= this.MIN_CONSISTENT_FRAMES) {
        this.lastActiveVisionTime = Date.now();
        this.evaluateConsensusCandidate(consensusCandidate);
      } else {
        // Evaluate noise/empty scene decay
        this.evaluateNoiseDrain();
      }
    } catch (err) {
      console.warn("Skipped inference frame due to processing interruption:", err);
    }
  }

  evaluateConsensusCandidate(rawClassName) {
    const parsedDenomination = this.extractDenomination(rawClassName);
    if (!parsedDenomination) return;

    const now = Date.now();
    const isNewNote = parsedDenomination !== this.currentAnnouncedNote;
    const cooldownElapsed = (now - this.lastAnnouncementTime) >= this.ANNOUNCE_COOLDOWN_MS;

    if (isNewNote || cooldownElapsed) {
      this.currentAnnouncedNote = parsedDenomination;
      this.lastAnnouncementTime = now;

      // Update Financial State if Tally Mode is active
      if (this.isTallyMode) {
        this.sessionTotal += parsedDenomination;
        if (this.displayTally) {
          this.displayTally.textContent = `₹${this.sessionTotal}`;
        }
      }

      // Update Visuals
      if (this.displayNote) {
        this.displayNote.textContent = `₹${parsedDenomination}`;
      }
      if (this.guidanceTip) {
        this.guidanceTip.textContent = `Confirmed: ₹${parsedDenomination}`;
      }

      // Dispatch Multimodal Feedback
      this.triggerHaptic(this.HAPTIC_PROFILES[parsedDenomination] || [200]);

      const noteWord = this.WORDS_MAP[parsedDenomination] || parsedDenomination;
      let announcement = `${noteWord} rupees.`;
      if (this.isTallyMode) {
        announcement = `${noteWord} rupees. Running total: ${this.sessionTotal} rupees.`;
      }

      this.speakResult(announcement, true);

      // Flush buffer immediately to prevent double-firing in the same burst
      this.predictionHistory = [];
    }
  }

  evaluateNoiseDrain() {
    const now = Date.now();
    // If the scene has lacked consensus for > 3000ms, unlock the previous note
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

  /* ---------------- TELEMETRY HUD (REQUIREMENT 3) ---------------- */

  renderTelemetry(top1, top2, votes, candidate) {
    if (!this.debugDisplay) return;

    const p1 = (top1.probability * 100).toFixed(0);
    const p2 = (top2.probability * 100).toFixed(0);
    const candidateName = candidate ? candidate.replace('_rupees', '') : 'None';

    this.debugDisplay.textContent =
      `Top: ${top1.className} (${p1}%) | Runner-up: ${top2.className} (${p2}%) | Consensus: ${votes}/${this.WINDOW_SIZE} (${candidateName})`;
  }

  /* ---------------- MULTIMODAL FEEDBACK & UTILITIES ---------------- */

  speakResult(text, cancelOngoing = false) {
    if (!('speechSynthesis' in window)) return;

    if (cancelOngoing) {
      window.speechSynthesis.cancel();
    }

    // Assertive live region for VoiceOver & TalkBack
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
    const subcontinentalVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang.startsWith('en'));
    if (subcontinentalVoice) {
      utterance.voice = subcontinentalVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  triggerHaptic(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Graceful fallback for devices restricting vibration
      }
    }
  }

  /* ---------------- GESTURE CONTROLS ---------------- */

  bindGestures() {
    this.surface.addEventListener('touchstart', (e) => {
      // Two-Finger Tap: Reset Running Tally
      if (e.touches.length === 2) {
        e.preventDefault();
        clearTimeout(this.singleTapTimer);
        clearTimeout(this.longPressTimer);
        this.resetTally();
        return;
      }

      // Long press (1.5s) fallback for single-hand reset
      if (e.touches.length === 1) {
        this.touchStartTime = Date.now();
        this.longPressTimer = setTimeout(() => {
          this.resetTally();
        }, 1500);
      }
    }, { passive: false });

    this.surface.addEventListener('touchend', (e) => {
      clearTimeout(this.longPressTimer);

      if (Date.now() - this.touchStartTime > 600) {
        return; // Ignore tap if held past long-press margin
      }

      if (e.touches.length > 0) return;

      const currentTime = Date.now();
      const tapGap = currentTime - this.lastTapTime;

      if (tapGap < 300 && tapGap > 0) {
        // Double tap: Toggle Torch
        clearTimeout(this.singleTapTimer);
        this.toggleTorch();
      } else {
        // Single tap: Repeat last denomination
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
    const btnMode = document.getElementById('sr-btn-mode');

    if (btnRepeat) btnRepeat.addEventListener('click', () => this.repeatAnnouncement());
    if (btnTorch) btnTorch.addEventListener('click', () => this.toggleTorch());
    if (btnReset) btnReset.addEventListener('click', () => this.resetTally());
    if (btnMode) btnMode.addEventListener('click', () => this.toggleMode());
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
        ? `No note recognized yet. Session total: ${this.sessionTotal} rupees.`
        : "No note recognized yet.";
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

  toggleMode() {
    this.isTallyMode = !this.isTallyMode;
    if (this.badgeMode) {
      this.badgeMode.textContent = this.isTallyMode ? "TALLY MODE" : "SINGLE SCAN";
    }
    this.speakResult(`Switched to ${this.isTallyMode ? "Tally Mode" : "Single Scan Mode"}.`, true);
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

// Bootstrap once the DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.identifier = new IndianBanknoteIdentifier();
});