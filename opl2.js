(function (window, document) {

var statusElem;
var audioctx, jsNode, gainNode;

var expTbl;
var logSinTbl;

var sampleRate_ = 44100;

var notenames = [
  'C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

// guessing the YM3812 doesn't have any sort of multiplier, just shift/add/sub
// with two taps, so these are the closest values you get when multiplying
// carrier frequencies
var freqMulTbl = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

// in .d00 adlib songs, the note corresponds to an entry in this table which is
// the per-sample increment for that note (assuming the default 49716
// samplerate and 10-bit wave table periods) represented as a 10-bit field + a
// 3-bit octave number
var d00NoteTable = [  // ripped from JCH's player
  0x0157, 0x016b, 0x0181, 0x0198, 0x01b0, 0x01ca, 0x01e5, 0x0202, 0x0220,
  0x0241, 0x0263, 0x0287, 0x0557, 0x056b, 0x0581, 0x0598, 0x05b0, 0x05ca,
  0x05e5, 0x0602, 0x0620, 0x0641, 0x0663, 0x0687, 0x0957, 0x096b, 0x0981,
  0x0998, 0x09b0, 0x09ca, 0x09e5, 0x0a02, 0x0a20, 0x0a41, 0x0a63, 0x0a87,
  0x0d57, 0x0d6b, 0x0d81, 0x0d98, 0x0db0, 0x0dca, 0x0de5, 0x0e02, 0x0e20,
  0x0e41, 0x0e63, 0x0e87, 0x1157, 0x116b, 0x1181, 0x1198, 0x11b0, 0x11ca,
  0x11e5, 0x1202, 0x1220, 0x1241, 0x1263, 0x1287, 0x1557, 0x156b, 0x1581,
  0x1598, 0x15b0, 0x15ca, 0x15e5, 0x1602, 0x1620, 0x1641, 0x1663, 0x1687,
  0x1957, 0x196b, 0x1981, 0x1998, 0x19b0, 0x19ca, 0x19e5, 0x1a02, 0x1a20,
  0x1a41, 0x1a63, 0x1a87, 0x1d57, 0x1d6b, 0x1d81, 0x1d98, 0x1db0, 0x1dca,
  0x1de5, 0x1e02, 0x1e20, 0x1e41, 0x1e63, 0x1e87];

var attackTable = [];

function initTables() {
  // The OPL2 synthesizer does not have any kind of multiplier; it multiplies
  // by adding in log space, and then exponentiating using this 2^0 .. 2^1
  // lookup table.
  expTbl = new Uint16Array(256);
  for (var i = 0; i < 256; i++) {
    // This is slightly different from what's stored in the actual ROM on the
    // chip in that the chip only stores bits 0..9 (bit 10 is always 1),
    // but it makes our own computations simpler.
    expTbl[i] = 2*Math.pow(2, 1 - i/256.0) * 1024 + 0.5;
  }

  // sine waves are stored in log format, in this table. On a real chip only a
  // quarter wave is stored in ROM, but to simplify the code we store a half
  // wave here at the cost of 256 more words of "ROM" (I think we can afford
  // that...)
  logSinTbl = new Uint16Array(512);
  for (var i = 0; i < 512; i++) {
    // logSinTbl = np.round(-np.log(np.sin((np.arange(512)+0.5) * np.pi / 512)) / np.log(2) * 256).astype(np.int32)
    logSinTbl[i] = -Math.log(Math.sin((i+0.5) * Math.PI / 512)) / Math.log(2) * 256 + 0.5;
  }
  var x = 512;
  for (var i = 0; i < 36; i++) {
    attackTable.push(8*x);
    x -= (x >> 3) + 1;
  }
}

function Operator() {
  this.waveform = 0;
  this.phase = 0;  // phase, float, [0..1024)
  this.phaseIncr = 0;  // phase increment per sample
  this.feedback = 0;
  this.lastSample1 = 0;
  this.lastSample0 = 0;
}

// Generate output wave into out (Int32Array), attenuated per-sample by vol (in
// "log volume" -- higher is quieter) which is also an Int32Array.
//
// This is specialized to the carrier wave, as it takes modulation as input and
// has no feedback.
//
// It also adds to its output, rather than setting it directly, for summing up
// the final waveform.
Operator.prototype.genCarrierWave = function(vol, modulation, numSamples, out) {
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
      var l = logSinTbl[m & 511] + vol[i];  // l = -log(sin(p)) - log(volume)
      var w = expTbl[l & 0xff] >> (l >> 8);  // table-based exponentiation: w = 4096 * 2^(-l/256)
      if (m & 512) w = -w;  // negative part of sin wave
      p += dp;  // phase increment
      out[i] += w;
    }
  } else if (this.waveform == 1) {  // chopped sine wave: ^-^-
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + modulation[i];
      if (m & 512) {
        var l = logSinTbl[m & 511] + vol[i];
        w = expTbl[l & 0xff] >> (l >> 8);
      }
      p += dp;
      out[i] += w;
    }
  } else if (this.waveform == 2) {  // abs sine wave: ^^^^
    for (var i = 0; i < numSamples; i++) {
      var m = p + modulation[i];
      var l = logSinTbl[m & 511] + vol[i];
      var w = expTbl[l & 0xff] >> (l >> 8);
      p += dp;
      out[i] += w;
    }
  } else if (this.waveform == 3) {  // chopped half sine wave: ////
    for (var i = 0; i < numSamples; i++) {
      var w = 0;
      var m = p + modulation[i];
      if (m & 256) {
        var l = logSinTbl[m & 255] + vol[i];
        w = expTbl[l & 0xff] >> (l >> 8);
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
Operator.prototype.genModulatorWave = function(vol, numSamples, out) {
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
  var w1 = this.lastSample1;
  var w = this.lastSample0;  // w = last waveform output sample
  var feedbackShift = 31;  // shift feedback down 31 bits (to 0)...
  if (this.feedback > 0) {  // ...unless we have a feedback set
    feedbackShift = 9 - this.feedback;
  }

  // Specialized versions of each waveform here, as this is the inner loop of
  // the player and it should be as tight as possible!
  // TODO: change ifs to integer masks where possible

  if (this.waveform == 0) {  // sine wave: ^v^v
    for (var i = 0; i < numSamples; i++) {
      var m = p + ((w + w1) >> feedbackShift);  // m = modulated phase
      w1 = w;
      var l = logSinTbl[m & 511] + vol[i];  // l = -log(sin(p)) - log(volume)
      w = expTbl[l & 0xff] >> (l >> 8);  // table-based exponentiation: w = 4096 * 2^(-l/256)
      if (m & 512) w = -w;  // negative part of sin wave
      p += dp;  // phase increment
      out[i] = w;
    }
  } else if (this.waveform == 1) {  // chopped sine wave: ^-^-
    for (var i = 0; i < numSamples; i++) {
      var m = p + ((w + w1) >> feedbackShift);
      w1 = w;
      if (m & 512) {
        var l = logSinTbl[m & 511] + vol[i];
        w = expTbl[l & 0xff] >> (l >> 8);
      } else {
        w = 0;
      }
      p += dp;
      out[i] = w;
    }
  } else if (this.waveform == 2) {  // abs sine wave: ^^^^
    for (var i = 0; i < numSamples; i++) {
      var m = p + ((w + w1) >> feedbackShift);
      w1 = w;
      var l = logSinTbl[m & 511] + vol[i];
      w = expTbl[l & 0xff] >> (l >> 8);
      p += dp;
      out[i] = w;
    }
  } else if (this.waveform == 3) {  // chopped half sine wave: ////
    for (var i = 0; i < numSamples; i++) {
      var m = p + ((w + w1) >> feedbackShift);
      w1 = w;
      if (m & 256) {
        var l = logSinTbl[m & 255] + vol[i];
        w = expTbl[l & 0xff] >> (l >> 8);
      } else {
        w = 0;
      }
      p += dp;
      out[i] = w;
    }
  }

  this.phase = p % 1024.0;
  this.lastSample1 = w1;
  this.lastSample0 = w;
}

// Generate ADSR (attack, decay, sustain, release) envelopes
function Envelope() {
  this.attackPhase = 0;  // phase within the particular mode
  this.adsrMode = 0;  // current mode: 0: attack, 1: decay, 2: sustain, 3: release
  this.attackInc = 0;
  this.decayInc = 0;
  this.sustainLevel = 0;
  this.releaseInc = 0;
  this.keyed = true;
  this.vol = 4095;

  // sustain note until released (if false, immediately release even with
  // keyOn)
  this.sustainMode = true;
}

// set opl2 ADSR registers (each 0..15)
Envelope.prototype.setADSR = function(att, dec, sus, rel) {
  // N.B.: needs adjustment for output sampling frequency
  // we also need to look at key scaling rate for the channel

  // So on a real YM3812, with attack set at 4, the volume changes every 512 samples
  // according to a schedule:
  //   v[0] = 4096
  //   v[i] = v[0] - (v[0]>>3) - 1
  // since each volume level has a period of 512 samples at rate 4,
  // rate 0 would have a period of 512 << 4 or 8192
  // so we have a 13-bit counter
  this.attackInc = 1 << att;  // TODO: adjust for relative sampling frequency

  // decay and release seem to use these linear rates
  this.decayInc = (1 << dec) / 768.0;  // ???
  this.releaseInc = (1 << rel) / 768.0;
  this.sustainLevel = sus << 7;  // this must be scaled by some factor. *shrug*
  // sustain level 0 is full volume
}

Envelope.prototype.keyOn = function() {
  this.attackPhase = 0;
  this.adsrMode = 0;
  this.keyed = true;
}

Envelope.prototype.keyOff = function() {
  this.keyed = false;
}

Envelope.prototype.generate = function(level, numSamples, out) {
  // this is just a guess for now, just to get some sounds
  var susLvl = this.sustainLevel;
  var vol = this.vol;
  var offset = 0;
  while (offset < numSamples) {
    if (this.adsrMode == 0) {  // attack
      while (offset < numSamples && this.attackPhase < 8192 * 36) {
        vol = attackTable[this.attackPhase >> 13];
        this.attackPhase += this.attackInc;
        out[offset++] = vol + level;
      }
      if (this.attackPhase >= 8192 * 36) {
        this.adsrMode++;
        vol = 0;
      }
    } else if (this.adsrMode == 1) {  // decay
      while (offset < numSamples) {
        out[offset++] = vol + level;
        vol += this.decayInc;
        if (vol >= susLvl) {
          vol = susLvl;
          this.adsrMode++;
          break;
        }
      }
    } else if (this.adsrMode == 2) {  // sustain
      if (!this.keyed || !this.sustainMode) {  // release note?
        this.adsrMode++;
        continue;
      }
      while (offset < numSamples) {
        out[offset++] = susLvl + level;
      }
    } else if (this.adsrMode == 3) {  // release
      while (offset < numSamples) {
        out[offset++] = vol + level;
        vol += this.releaseInc;
        if (vol > 4095) {
          vol = 4095;
        }
      }
    } else {
      throw "invalid adsrMode " + this.adsrMode;
    }
  }
  this.vol = vol;
}

function Channel(num, globalLevel) {
  this.num = num;
  this.carrier = new Operator();
  this.cenv = new Envelope();
  this.cmul = 1;
  this.modulator = new Operator();
  this.menv = new Envelope();
  this.mmul = 1;
  this.clevel = 0;
  this.mlevel = 0;
  this.level = 0;
  this.globalLevel = globalLevel << 5;
  this.connection = 0;
}

// Set up channel according to D00 player instrument parameters
// (this will be refactored later into a separate player, no doubt)
Channel.prototype.setD00Instrument = function(data) {
  //    0  1  2  3  4    5  6  7  8  9   10
  // 0 ff ff 3f 20 00 | ff ff 3f 20 00 | 00 | 00 00 00 00 00
  // 1 96 14 00 21 01 | 6f 33 00 00 02 | 00 | 00 00 00 00 00
  // 2 ff 36 00 21 00 | ff 01 00 02 00 | 0c | 00 00 02 00 00
  // 3 cf 05 40 21 00 | f4 36 0f 20 02 | 0a | 00 00 00 00 00
  // 4 aa 24 00 21 01 | ff 04 0a 21 00 | 06 | 00 00 00 00 00
  // 5 f9 15 00 21 01 | ff 01 08 00 02 | 02 | 00 00 00 00 00
  // 6 ff 26 00 20 00 | f7 64 10 21 01 | 08 | 00 00 00 00 00
  // 7 cf 05 46 61 00 | ff 05 10 41 00 | 00 | 00 00 00 00 00
  // 8 ff 06 00 01 00 | f4 36 0f 01 00 | 00 | 00 00 00 00 00
  //   AD SR CL CM WF | AD SR ML MM WF | FC | FT HR SR XX XX
  // -- carrier ---   --modulator --
  // CL: carrier level 00-3F; high 2 bits are keyboard scale level
  // CM: carrier multiple: TVEK|MLT --
  //   tremolo 80, vibrato 40, envelope 20 for ADSR (otherwise ADR)
  //   10 KSR, 00-0F sets carrier multiple (0.5, 1, 2, 3, ... 15)
  // WF: waveform, 00-03
  // ML: modulator level 00-3F, high 2 bits are KSL
  // MM: modulator multiple, same as carrier
  // FC: feedback / connection: bit 0 is 1=additive, 0=FM, bits 1-3 feedback 0..7
  //
  // FT: fine tune
  // HR / SR: hard restart ??? rarely used
  // last two unused

  this.cenv.setADSR(data[0] >> 4, data[0] & 0x0f, data[1] >> 4, data[1] & 0x0f);
  this.menv.setADSR(data[5] >> 4, data[5] & 0x0f, data[6] >> 4, data[6] & 0x0f);
  this.clevel = (data[2] & 0x3f) << 5;  // unsure about this shift
  this.mlevel = (data[7] & 0x3f) << 5;
  // TODO: KSL data[2/7] >> 6
  this.cmul = freqMulTbl[data[3] & 0x0f];
  this.mmul = freqMulTbl[data[8] & 0x0f];
  // console.log("instrument", data, 'cmul', this.cmul, 'mmul', this.mmul);
  // TODO: tremolo data[3/8] & 0x80
  // TODO: vibrato data[3/8] & 0x40
  this.cenv.sustainMode = !!(data[3] & 0x20);
  this.menv.sustainMode = !!(data[8] & 0x20);
  // TODO: KSR data[3/8] & 0x10
  this.carrier.waveform = data[4];
  this.modulator.waveform = data[9];
  this.modulator.feedback = data[10] >> 1;
  this.connection = data[10] & 1;
}

Channel.prototype.setFreqReg = function(freqReg) {
  // adjust increments for local playback sampling rate sampleRate_
  // original chip sample clock is 14.31818MHz divided down by 288
  var f_scale = 14313180.0 / (288 * sampleRate_);
  var incr = ((freqReg & 0x3ff) << ((freqReg >> 10) & 7)) / 1024.0;
  this.carrier.phaseIncr = incr * this.cmul * f_scale;
  this.modulator.phaseIncr = incr * this.mmul * f_scale;
}

Channel.prototype.playD00Note = function(note, retrig) {
  this.freqReg = d00NoteTable[note];
  this.setFreqReg(this.freqReg);

  if (retrig) {
    this.cenv.keyOn();
    this.menv.keyOn();
  }
}

Channel.prototype.releaseNote = function() {
  this.cenv.keyOff();
  this.menv.keyOff();
}

Channel.prototype.setLevel = function(level) {
  this.level = level << 5;
}

// generation requires two scratch buffers at least as big as numSamples
Channel.prototype.generate = function(numSamples, out, scratch1, scratch2) {
  // FIXME: if connection == 1, then just add modulator and carrier
  //   and don't forget to add level to mlevel

  // modulator volume envelope into scratch1
  this.menv.generate(this.mlevel, numSamples, scratch1);
  // modulator output into scratch1
  this.modulator.genModulatorWave(scratch1, numSamples, scratch1);
  // carrier envelope into scratch2
  this.cenv.generate(this.clevel + this.level + this.globalLevel, numSamples, scratch2);
  // and final output into out
  this.carrier.genCarrierWave(scratch2, scratch1, numSamples, out);
}

function D00Sequencer(arrangement, song) {
  this.arrangement = arrangement;
  this.speed = 2;  // arrangement[0];  // first arrangement entry is speed
  this.transpose = 0;
  this.arrOffset = 1;  // skip speed entry

  // tick, seqPtr point to next thing to play
  this.seq = this.nextSeq(song);
  this.seqPtr = 0;
  this.effect = 0;
  this.tick = 0;
  this.repeatCount = 0;

  this.slide = 0;

  this.vibDepth = 0;
  this.vibRate = 0;
  this.vibIdx = 0;

  this.instNum = 0;
  this.displayEff = "    ";
  this.displayNote = "---";
}

// get next sequence in arrangement
D00Sequencer.prototype.nextSeq = function(song, channel) {
  while (true) {
    if (this.arrOffset >= this.arrangement.length) {
      return;  // ran off the end??
    }
    var e = this.arrangement[this.arrOffset++];
    if (e == 0xfffe) {
      this.arrOffset--;  // hang here forever
      return;
    } else if (e == 0xffff) {
      this.arrOffset = 1 + this.arrangement[this.arrOffset];  // loop back to beginning
    } else if (e >= 0x8000) {
      this.transpose = e & 0xff;
    } else {
      return song.sequences[e];
    }
  }
}

// update to next row in sequence
D00Sequencer.prototype.nextRow = function(song, channel) {
  if (this.seq === undefined) {  // nothing to play
    return;
  }
  if (this.repeatCount > 0) {
    this.displayNote = "---";
    this.repeatCount--;
    return;
  }
  var slide = 0;
  while (true) {
    if (this.seqPtr >= this.seq.length) {
      this.seq = this.nextSeq(song);
      this.seqPtr = 0;
    }
    var e = this.seq[this.seqPtr++];
    var eff = e >> 12;
    var data = e & 0xff;
    // console.log(this.seqPtr, e, eff, data);
    if (eff == 0x09) {  // change level
      channel.setLevel(data);
    } else if (eff == 0x07) {  // vibrato
      this.vibrato = e & 0xfff;
    } else if (eff == 0x0d) {  // portamento up
      slide = data;
    } else if (eff == 0x0e) {  // portamento down
      slide = -data;
    } else if (eff == 0x0b) {  // spfx?
      // hack, spfx not supported but at least we can use the instrument
      channel.setD00Instrument(song.instruments[song.spfx[data][0]]);
    } else if (eff == 0x0c) {  // change instrument?
      // console.log('instrument', channel.num, data);
      channel.setD00Instrument(song.instruments[data]);
      this.instNum = data;
    } else if (eff < 4) {  // note w/ tie or repeats
      var retrig = eff < 2;  // 0000-1fff -> note (retrigger), 2000-3fff -> tie
      repeat = (e & 0x1fff) >> 8;
      note = e & 0xff;
      this.repeatCount = repeat;
      if (note == 0) {
        channel.releaseNote();
        this.displayNote = "^^^";
      } else if (note < 96) {
        channel.playD00Note(note + this.transpose, retrig);
        this.vibDepth = 0;  // this is how the d00 player asm code does it
        // reset pending effects
        this.displayNote = notenames[note % 12] + ""+(0|(note / 12));
      }

      if (this.vibrato !== undefined) {
        this.vibRate = (this.vibrato & 0xf00) >> 8;
        this.vibDepth = this.vibrato & 0xff;
        this.vibPos = this.vibRate >> 1;
      }
      this.slide = slide;  // update per-tick effects
      this.vibrato = undefined;

      return;
    }
  }
}

// update to next tick in row
D00Sequencer.prototype.nextTick = function(song, channel) {
  var newRow = false;
  if (this.tick == 0) {
    this.nextRow(song, channel);
    newRow = true;
  }
  if (this.tick != 0) {
    var resetFreq = false;
    if (this.slide != 0) {
      channel.freqReg += this.slide;
      resetFreq = true;
    }
    if (this.vibRate != 0) {
      if (this.vibPos >= 0) {
        channel.freqReg += this.vibDepth;
        this.vibPos--;
        if (this.vibPos == 0) {
          this.vibPos = -this.vibRate;
        }
      } else {
        channel.freqReg -= this.vibDepth;
        this.vibPos++;
        if (this.vibPos == 0) {
          this.vibPos = this.vibRate;
        }
      }
      resetFreq = true;
    }
    if (resetFreq) {
      channel.setFreqReg(channel.freqReg);
    }
  }
  this.tick++;
  if (this.tick > this.speed) {
    this.tick = 0;
  }
  return newRow;
}

function D00Player(song) {
  this.tickRate = 50;
  this.tickOffset = 0;
  this.channels = [];
  this.sequencers = [];
  this.song = song;
  for (var i = 0; i < 9; i++) {
    this.channels[i] = new Channel(i, song.chvol[i]);
    this.sequencers[i] = new D00Sequencer(song.arrangement[i], song)
  }
  // one-note test
  // this.channels[0].setD00Instrument(song.instruments[1]);
  // this.channels[0].playD00Note(48);
}

// var f = 0;
D00Player.prototype.nextTick = function() {
  var newRow = false;
  /*
  // one-note test
  f++;
  if (f == 40) {
    this.channels[0].releaseNote();
  }
  return false;
  */

  for (var i = 0; i < 9; i++) {
    // console.log("nextTick", i);
    if (this.sequencers[i].nextTick(this.song, this.channels[i])) {
      newRow = true;
    }
  }
  return newRow;
}

var patternDisplay = [];
D00Player.prototype.updateDisplay = function() {
  rowDisplay = [];
  for (var i = 0; i < 9; i++) {
    rowDisplay.push(this.sequencers[i].instNum + " " + this.sequencers[i].displayNote);
  }
  patternDisplay.push(rowDisplay.join(' | '));
  while (patternDisplay.length > 16) {
    patternDisplay.shift();
  }
  document.getElementById("b").innerHTML = patternDisplay.join("\n");
}

D00Player.prototype.generate = function(bufLength, dataL, dataR) {
  // if i were ambitious here this would be a float
  var samplesPerTick = 0 | (sampleRate_ / this.tickRate);

  var scratch1 = new Int32Array(samplesPerTick);
  var scratch2 = new Int32Array(samplesPerTick);
  var outbuf = new Int32Array(samplesPerTick);

  var offset = 0;
  while (offset < bufLength) {
    if (this.tickOffset == 0) {
      if (this.nextTick()) {
        this.updateDisplay();
      }
    }
    var samplesLeftInTick = samplesPerTick - this.tickOffset;
    if (samplesLeftInTick == 0) {
      throw "this should never happen... or should it?";
    }
    var numSamples = Math.min(samplesLeftInTick, bufLength - offset);

    for (var j = 0; j < 9; j++) {
      this.channels[j].generate(numSamples, outbuf, scratch1, scratch2);
    }

    for (i = 0; i < numSamples; i++) {
      dataL[offset + i] = outbuf[i] * (1.0 / 4096.0);
      dataR[offset + i] = dataL[offset+i];  // TODO: add a spatialization filter
      outbuf[i] = 0;
    }

    offset += numSamples;
    this.tickOffset += numSamples;
    if (this.tickOffset >= samplesPerTick) {
      this.tickOffset = 0;
    }
  }
}

d00Player = new D00Player(window.song);

function audioCallback(e) {
  // set global sample rate
  sampleRate_ = audioctx.sampleRate;

  var buflen = e.outputBuffer.length;
  var dataL = e.outputBuffer.getChannelData(0);
  var dataR = e.outputBuffer.getChannelData(1);

  d00Player.generate(buflen, dataL, dataR);
}

window.onload = function() {
  initTables();

  if (!audioctx) {
    var audioContext = window.AudioContext || window.webkitAudioContext;
    audioctx = new audioContext();
    gainNode = audioctx.createGain();
    gainNode.gain.value = 0.2;  // master volume
  }
  if (audioctx.createScriptProcessor === undefined) {
    jsNode = audioctx.createJavaScriptNode(2048, 0, 2);
  } else {
    jsNode = audioctx.createScriptProcessor(2048, 0, 2);
  }
  jsNode.onaudioprocess = audioCallback;
  jsNode.connect(gainNode);

  if (1) {
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
  statusElem.innerHTML = "(((waves of warez)))\nplaying crooner.d00 by drax / vibrants";

  window.audioctx = audioctx;
  window.jsNode = jsNode;
}

window.OPL2 = {
  init: initTables,
  Channel: Channel,
  Envelope: Envelope,
  Operator: Operator,
};

window.d00Player = d00Player;

})(window, document);
