window = {};
document = {};

require('../song.js');
window.song = song;
// console.log(song);

require('../opl2.js');

var OPL2 = window.OPL2;
OPL2.init();

exports['test envelope'] = function(assert) {
  var e = new OPL2.Envelope();
  e.setADSR(13, 10, 1, 8);
  var out = new Int32Array(1000);
  e.generate(0, 1000, out);
  assert.equal(out[1], 3576, "attack 1");
  assert.equal(out[7], 1592, "attack 7");
  assert.equal(out[35], 0, "attack 35");

  // TODO: get fresh decay / release envelopes from actual chip, check rate here

  assert.equal(out[999], 128, "sustain level");
};

exports['test player sound gen'] = function(assert) {
  var p = window.d00Player;
  var out = new Int32Array(1000);
  var s1 = new Int32Array(1000);
  var s2 = new Int32Array(1000);

  var chan = p.channels[0];
  console.log(chan);
  chan.menv.generate(0, 1000, s1);
  console.log(chan.modulator);
  chan.modulator.genModulatorWave(s1, 1000, s1);
  chan.cenv.generate(0, 1000, s2);
  chan.carrier.genCarrierWave(s2, s1, 1000, out);

  // window.d00Player.channels[0].generate(1000, out, s1, s2);
  // console.log(out);
};

exports['test d00 sequencer'] = function(assert) {
  var p = window.d00Player;

  p.sequencers[1].nextTick(p.song, p.channels[0]);
};

if (module == require.main) require('test').run(exports);
