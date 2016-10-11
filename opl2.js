(function (window, document) {

var statusElem;
var audioctx, jsNode, gainNode;

var exptbl;
var logsintbl;

function InitTables() {
  // The OPL2 synthesizer does not have any kind of multiplier; it multiplies
  // by adding in log space, and then exponentiating using this 2^0 .. 2^1
  // lookup table.
  exptbl = new Uint16Array(256);
  for (var i = 0; i < 256; i++) {
    // This is slightly different from what's stored in the actual ROM on the
    // chip in that the chip only stores bits 0..9 (bit 10 is always 1),
    // but it makes our own computations simpler.
    exptbl[i] = 2*Math.pow(2, 1 - i/256.0) * 1024 + 0.5;
  }

  // sine waves are stored in log format, in this table. On a real chip only a
  // quarter wave is stored in ROM, but to simplify the code we store a half
  // wave here at the cost of 256 more words of "ROM" (I think we can afford
  // that...)
  logsintbl = new Uint16Array(512);
  for (var i = 0; i < 512; i++) {
    // logsintbl = np.round(-np.log(np.sin((np.arange(512)+0.5) * np.pi / 512)) / np.log(2) * 256).astype(np.int32)
    logsintbl[i] = -Math.log(Math.sin((i+0.5) * Math.PI / 512)) / Math.log(2) * 256 + 0.5;
  }
}

function Operator() {
  this.waveform = 0;
  this.phase = 0;  // phase, float, [0..1024)
  this.phaseIncr = 0;  // phase increment per sample
  this.feedback = 0;
  this.lastSample = 0;
}

// Generate output wave into out (Int32Array), attenuated per-sample by vol (in
// "log volume" -- higher is quieter) which is also an Int32Array.
//
// This is specialized to the carrier wave, as it takes modulation as input and
// has no feedback.
//
// It also adds to its output, rather than setting it directly, for summing up
// the final waveform.
Operator.prototype.genCarrierWave = function(vol, modulation, out, numSamples) {
  if (vol.length < numSamples) {
    throw "genCarrierWave: volume buffer too short " +
      vol.length + " / " + numSamples;
  }
  if (modulation.length < numSamples) {
    throw "genCarrierWave: modulation buffer too short " +
      modulation.length + " / " + numSamples;
  }
  if (out.length < numSamples) {
    throw "genCarrierWave: output buffer too short " +
      output.length + " / " + numSamples;
  }

  var p = this.phase;
  var dp = this.phaseIncr;

  // Specialized versions of each waveform here, as this is the inner loop of
  // the player and it should be as tight as possible!
  // TODO: change ifs to integer masks where possible

  if (this.waveform == 0) {  // sine wave: ^v^v
    for (var i = 0; i < numSamples; i++) {
      var m = p + modulation[i];  // m = modulated phase
      var l = logsintbl[m & 511] + vol[i];  // l = -log(sin(p)) - log(volume)
      var w = exptbl[l & 0xff] >> (l >> 8);  // table-based exponentiation: w = 4096 * 2^(-l/256)
      if (m & 512) w = -w;  // negative part of sin wave
      p += dp;  // phase increment
      out[i] += w;
    }
  } else if (this.waveform == 1) {  // chopped sine wave: ^-^-
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + modulation[i];
      if (m & 512) {
        var l = logsintbl[m & 511] + vol[i];
        w = exptbl[l & 0xff] >> (l >> 8);
      }
      p += dp;
      out[i] += w;
    }
  } else if (this.waveform == 2) {  // abs sine wave: ^^^^
    for (var i = 0; i < numSamples; i++) {
      var m = p + modulation[i];
      var l = logsintbl[m & 511] + vol[i];
      var w = exptbl[l & 0xff] >> (l >> 8);
      p += dp;
      out[i] += w;
    }
  } else if (this.waveform == 3) {  // chopped half sine wave: ////
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + modulation[i];
      if (m & 256) {
        var l = logsintbl[m & 255] + vol[i];
        w = exptbl[l & 0xff] >> (l >> 8);
      }
      p += dp;
      out[i] += w;
    }
  }

  this.phase = p % 1024.0;
}

// Generate modulator wave into out (Int32Array), attenuated per-sample by vol (in
// "log volume" -- higher is quieter) which is also an Int32Array.
//
// This is specialized to the modulator wave, as it implements feedback
// (self-modulation).
Operator.prototype.genModulatorWave = function(vol, out) {
  if (vol.length < numSamples) {
    throw "genModulatorWave: volume buffer too short " +
      vol.length + " / " + numSamples;
  }
  if (out.length < numSamples) {
    throw "genModulatorWave: output buffer too short " +
      output.length + " / " + numSamples;
  }

  var p = this.phase;
  var dp = this.phaseIncr;
  var w = this.lastSample;  // w = last waveform output sample
  var feedbackShift = 31;  // shift feedback down 31 bits (to 0)...
  if (this.feedback > 0) {  // ...unless we have a feedback set
    feedbackShift = 9 - this.feedback;
  }

  // Specialized versions of each waveform here, as this is the inner loop of
  // the player and it should be as tight as possible!
  // TODO: change ifs to integer masks where possible

  if (this.waveform == 0) {  // sine wave: ^v^v
    for (var i = 0; i < numSamples; i++) {
      var m = p + (w >> feedbackShift);  // m = modulated phase
      var l = logsintbl[m & 511] + vol[i];  // l = -log(sin(p)) - log(volume)
      var w = exptbl[l & 0xff] >> (l >> 8);  // table-based exponentiation: w = 4096 * 2^(-l/256)
      if (m & 512) w = -w;  // negative part of sin wave
      p += dp;  // phase increment
      out[i] = w;
    }
  } else if (this.waveform == 1) {  // chopped sine wave: ^-^-
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + (w >> feedbackShift);
      if (m & 512) {
        var l = logsintbl[m & 511] + vol[i];
        w = exptbl[l & 0xff] >> (l >> 8);
      }
      p += dp;
      out[i] = w;
    }
  } else if (this.waveform == 2) {  // abs sine wave: ^^^^
    for (var i = 0; i < numSamples; i++) {
      var m = p + (w >> feedbackShift);
      var l = logsintbl[m & 511] + vol[i];
      var w = exptbl[l & 0xff] >> (l >> 8);
      p += dp;
      out[i] = w;
    }
  } else if (this.waveform == 3) {  // chopped half sine wave: ////
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + (w >> feedbackShift);
      if (m & 256) {
        var l = logsintbl[m & 255] + vol[i];
        w = exptbl[l & 0xff] >> (l >> 8);
      }
      p += dp;
      out[i] = w;
    }
  }

  this.phase = p % 1024.0;
  this.lastSample = w;
}

// Generate ADSR (attack, decay, sustain, release) envelopes
function Envelope() {
  this.adsrPhase = 0;
  this.attackInc = 0;
  this.decayInc = 0;
  this.sustainLevel = 0;
  this.releaseInc = 0;

  // sustain note until released (if false, immediately release)
  this.sustainMode = true;
}

// set opl2 ADSR registers (each 0..15)
Envelope.prototype.setADSR(att, dec, sus, rel) {
  // N.B.: needs adjustment for output sampling frequency

  // just a guess here based on the weird dosbox adlib code
  // will test on a real YM3812 soon
  // attack follows the half-sine curve 0..255
  // and it takes something like (282624 >> att) samples to complete
  // so dt * (282624 >> att) = 255
  // dt = 255 / (282624 >> att)
  //    = (255 << att) / 282624
  this.attackInc = (255 << att) / 282624;
}

function audioCallback(e) {
  var f_smp = audioctx.sampleRate;
  var buflen = e.outputBuffer.length;
  var dataL = e.outputBuffer.getChannelData(0);
  var dataR = e.outputBuffer.getChannelData(1);

  for (i = 0; i < buflen; i++) {
    dataL[i] = 0;
    dataR[i] = 0;
  }
}

window.onload = function() {
  InitTables();

  if (!audioctx) {
    var audioContext = window.AudioContext || window.webkitAudioContext;
    audioctx = new audioContext();
    gainNode = audioctx.createGain();
    gainNode.gain.value = 0.1;  // master volume
  }
  if (audioctx.createScriptProcessor === undefined) {
    jsNode = audioctx.createJavaScriptNode(16384, 0, 2);
  } else {
    jsNode = audioctx.createScriptProcessor(16384, 0, 2);
  }
  jsNode.onaudioprocess = audioCallback;
  jsNode.connect(gainNode);

  if (0) {
    gainNode.connect(audioctx.destination);

    // hack to get iOS to play anything
    var temp_osc = audioctx.createOscillator();
    temp_osc.connect(audioctx.destination);
    if (temp_osc.noteOn) temp_osc.start = temp_osc.noteOn;
    temp_osc.start(0);
    temp_osc.stop();
    temp_osc.disconnect();
  }

  statusElem = document.getElementById("a");
  statusElem.innerHTML = "load";

  window.audioctx = audioctx;
  window.jsNode = jsNode;
}

window.Operator = Operator;

})(window, document);
