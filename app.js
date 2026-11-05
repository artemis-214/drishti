/**
 * WCAG 2.2 AAA Compliant Real-Time Indian Banknote Identifier
 */

class BanknoteIdentifier {
  constructor() {
    this.video = document.getElementById('camera-stream');
    this.canvas = document.getElementById('inference-canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    
    this.srAssertive = document.getElementById('sr-assertive-region');
    this.srPolite = document.getElementById('sr-polite-region');
    
    this.detectedValEl = document.getElementById('detected-val');
    this.tallyValEl = document.getElementById('tally-val');
    this.guidanceTextEl = document.getElementById('guidance-text');
    this.torchBadge = document.getElementById('torch-badge');
    this.viewport = document.getElementById('app-viewport');
    this.starterOverlay = document.getElementById('audio-starter-overlay');
    this.btnActivate = document.getElementById('btn-activate');

    this.stream = null;
    this.track = null;
    this.isTorchOn = false;
    this.runningTotal = 0;
    this.lastDetectedDenomination = null;
    this.consecutiveDetections = 0;
    this.activePrediction = null;
    this.isProcessing = false;
    this.audioContext = null;

    // Haptics tuned for street vibration profiles
    this.HAPTICS = {
      10: [100],
      20: [150, 80, 150],
      50: [300],
      100: [300, 100, 100],
      200: [300, 100, 200, 100],
      500: [300, 100, 300, 100, 300],
      reset: [80, 40, 80, 40, 80],
      torch: [60],
      boundary: [30]
    };

    this.lastAnnouncement = '';
    this.lastAnnouncementTime = 0;

    this.init();
  }

  init() {
    this.btnActivate.addEventListener('click', () => this.unlockAndStart());
    this.bindControls();
    this.registerServiceWorker();
  }

  async unlockAndStart() {
    this.initAudio();
    this.starterOverlay.classList.add('hidden');
    await this.startCamera();
    this.announce("Scanner started. Present banknote.", "assertive");
    this.startInferencePipeline();
  }

  /* ---------------- AUDIO & SCREEN READER CORE ---------------- */

  initAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  announce(message, priority = 'polite') {
    const targetRegion = priority === 'assertive' ? this.srAssertive : this.srPolite;
    
    // Clear first to guarantee re-announcement of identical values by VoiceOver/TalkBack
    targetRegion.textContent = '';
    setTimeout(() => {
      targetRegion.textContent = message;
    }, 40);

    this.speak(message, priority === 'assertive');
  }

  speak(text, cancelOngoing = false) {
    if (!('speechSynthesis' in window)) return;

    const now = Date.now();
    if (!cancelOngoing && text === this.lastAnnouncement && (now - this.lastAnnouncementTime) < 1500) {
      return;
    }

    if (cancelOngoing) {
      window.speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const subcontinentalVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang === 'hi-IN');
    if (subcontinentalVoice) utterance.voice = subcontinentalVoice;

    this.lastAnnouncement = text;
    this.lastAnnouncementTime = now;
    window.speechSynthesis.speak(utterance);
  }

  playSpatialFeedback(panX) {
    if (!this.audioContext) return;
    
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const panner = this.audioContext.createStereoPanner ? this.audioContext.createStereoPanner() : null;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(800, this.audioContext.currentTime);

    gain.gain.setValueAtTime(0.001, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, this.audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.07);

    if (panner) {
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, panX)), this.audioContext.currentTime);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.audioContext.destination);
    } else {
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
    }

    osc.start();
    osc.stop(this.audioContext.currentTime + 0.08);
  }

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (e) { /* vendor safe */ }
    }
  }

  /* ---------------- HARDWARE CONTROLS ---------------- */

  async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: { ideal: 'continuous' }
        }
      });
      this.video.srcObject = this.stream;
      this.track = this.stream.getVideoTracks()[0];
      await this.video.play();
    } catch (err) {
      this.announce("Camera permission denied. Visual detection is inactive.", "assertive");
      this.guidanceTextEl.textContent = "Camera access denied";
    }
  }

  async toggleTorch() {
    if (!this.track) return;
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (!caps.torch) {
        this.announce("Flashlight unavailable on this device", "polite");
        return;
      }
      this.isTorchOn = !this.isTorchOn;
      await this.track.applyConstraints({ advanced: [{ torch: this.isTorchOn }] });
      this.vibrate(this.HAPTICS.torch);
      this.torchBadge.textContent = `TORCH: ${this.isTorchOn ? 'ON' : 'OFF'}`;
      this.torchBadge.classList.toggle('active', this.isTorchOn);
      this.announce(`Flashlight ${this.isTorchOn ? 'on' : 'off'}`, "polite");
    } catch (err) {
      this.announce("Failed to toggle flashlight", "polite");
    }
  }

  /* ---------------- INFERENCE & AUDITORY SPATIALIZATION ---------------- */

  startInferencePipeline() {
    const cycle = async () => {
      if (this.video.readyState === this.video.HAVE_ENOUGH_DATA && !this.isProcessing) {
        this.isProcessing = true;
        await this.detectFrame();
        this.isProcessing = false;
      }
      requestAnimationFrame(cycle);
    };
    requestAnimationFrame(cycle);
  }

  async detectFrame() {
    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    const frameData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const detection = await this.runInference(frameData);

    if (detection && detection.found) {
      this.evaluateAlignment(detection.box);
      this.handleVerification(detection.denomination, detection.score);
    } else {
      this.consecutiveDetections = 0;
      this.activePrediction = null;
    }
  }

  async runInference(frameData) {
    // Model inference contract placeholder (TensorFlow.js / Edge ML)
    return null;
  }

  evaluateAlignment(box) {
    if (!box) return;
    const centerX = box.xMin + (box.width / 2);
    const boxArea = box.width * box.height;

    if (boxArea > 0.85) {
      this.announce("Move back", "assertive");
      this.vibrate(this.HAPTICS.boundary);
      return;
    }

    if (centerX < 0.35) {
      this.playSpatialFeedback(-0.8);
      this.guidanceTextEl.textContent = "Shift right";
    } else if (centerX > 0.65) {
      this.playSpatialFeedback(0.8);
      this.guidanceTextEl.textContent = "Shift left";
    } else {
      this.guidanceTextEl.textContent = "Aligned centered";
    }
  }

  handleVerification(denomination, confidence) {
    if (confidence < 0.85) return;

    if (this.activePrediction === denomination) {
      this.consecutiveDetections++;
    } else {
      this.activePrediction = denomination;
      this.consecutiveDetections = 1;
    }

    if (this.consecutiveDetections === 3) {
      this.commitDetection(denomination);
    }
  }

  commitDetection(value) {
    this.lastDetectedDenomination = value;
    this.runningTotal += value;

    this.detectedValEl.textContent = `₹${value}`;
    this.tallyValEl.textContent = `₹${this.runningTotal}`;

    this.vibrate(this.HAPTICS[value] || [200]);
    this.announce(`${value} rupees. Total: ${this.runningTotal} rupees.`, "assertive");
  }

  /* ---------------- INTERFACES (TOUCH & SWITCH) ---------------- */

  bindControls() {
    // Physical Button Controls (Guaranteed TalkBack / VoiceOver Activation Target)
    document.getElementById('btn-repeat').addEventListener('click', () => this.repeatLast());
    document.getElementById('btn-torch').addEventListener('click', () => this.toggleTorch());
    document.getElementById('btn-reset').addEventListener('click', () => this.resetTally());

    // Fallback Viewport Tap for non-screen reader users who prefer direct surface gestures
    let lastTap = 0;
    this.viewport.addEventListener('touchend', (e) => {
      // Ignore if clicking direct buttons
      if (e.target.closest('button')) return;

      const now = Date.now();
      if (now - lastTap < 300) {
        this.toggleTorch();
      } else {
        setTimeout(() => {
          if (Date.now() - lastTap >= 300) this.repeatLast();
        }, 300);
      }
      lastTap = now;
    });
  }

  repeatLast() {
    if (this.lastDetectedDenomination) {
      this.announce(`Last note: ${this.lastDetectedDenomination} rupees. Total: ${this.runningTotal} rupees.`, "assertive");
    } else {
      this.announce(`No note detected yet. Total: ${this.runningTotal} rupees.`, "assertive");
    }
  }

  resetTally() {
    this.runningTotal = 0;
    this.lastDetectedDenomination = null;
    this.tallyValEl.textContent = "₹0";
    this.detectedValEl.textContent = "READY";
    this.vibrate(this.HAPTICS.reset);
    this.announce("Total cleared. Running total is zero rupees.", "assertive");
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new BanknoteIdentifier();
});