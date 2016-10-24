// teensy arduino sketch for interfacing with a YM3812,
// playing notes, and reading the serial digital samples back
// and writing back to USB serial.

// pin map:
// teensy | YM3812
// PORTD = D0..D7  (pins 2, 14, 7, 8, 6, 20, 21, 5)
// pin 13 = A0
// pin 15 = /WR
// pin 16 -> /CS
// (pullup) -> /RD
// (pulldown) -> /IC

// bus pins for programming YM3812
static const int pin_a0 = 13;
static const int pin_wr = 15;
static const int pin_cs = 16;

// digital sample input from YM3812 (also sent to YM3014B DAC)
static const int pin_clk = 23;    // PTC2 (all on PORTC)
static const int mask_clk = 0x04;
static const int pin_data = 22;   // PTC1
static const int mask_data = 0x02;
static const int shift_data = 16 - 2;  // 0x02 << 14 = 0x8000
static const int pin_sync = 12;   // PTC7
static const int mask_sync = 0x80;
static const int pin_syncIndicator = 18;

uint16_t notetbl[] = {
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
  0x1de5, 0x1e02, 0x1e20, 0x1e41, 0x1e63, 0x1e87};

uint8_t notenum = 40;

void ym3812_write1(uint8_t addr, uint8_t data) {
  // write reg
  digitalWrite(pin_a0, addr);  // set a0
  digitalWrite(pin_cs, 0);  // assert /CS
  GPIOD_PDOR = data;    // write data
  digitalWrite(pin_wr, 0);  // assert /WR
  // 100ns
  delayMicroseconds(0);  // FIXME
  digitalWrite(pin_wr, 1);  // unassert /WR
  digitalWrite(pin_cs, 1);  // unassert /CS
}

void ym3812_write(uint8_t reg, uint8_t val) {
  ym3812_write1(0, reg);
  delayMicroseconds(4);
  ym3812_write1(1, val);
  delayMicroseconds(23);
}

// read a sample sent to the YM3014B
// it's a 13.3 floating point format, 3 MSBs are exponent,
// 13 LSBs are mantissa, except only 10 of the mantissa bits are used
uint16_t ym3014b_read16(void) {
  uint16_t data = 0;
  uint8_t last_port_state = GPIOC_PDIR;

  // wait for rising clock edge
  // if we see a falling sync edge, return data

  while (true) {
    uint8_t port_state = GPIOC_PDIR;
    uint8_t change = port_state ^ last_port_state;
    // rising clock edge, shift in a data bit
    if ((change & mask_clk) && (port_state & mask_clk)) {
      data = (data >> 1) | ((port_state & mask_data) << shift_data);
    }
    // falling sync edge; we're done
    if ((change & mask_sync) && (last_port_state & mask_sync)) {
      return data;
    }
    last_port_state = port_state;
  }
}

void setup() {
  Serial.begin(19200);  // baud rate is fictional; it's USB 1.2MB/s
  
  // put your setup code here, to run once:
  // PORTD = D0..D7  (pins 2, 14, 7, 8, 6, 20, 21, 5), plus 13 and 15
  static const uint8_t output_pins[] = {
    2, 5, 6, 7, 8, 14, 20, 21,   // D0..D7
    pin_a0, pin_wr, pin_cs, pin_syncIndicator
  };
  for (uint8_t i = 0; i < sizeof(output_pins); i++) {
    pinMode(output_pins[i], OUTPUT);
  }
  digitalWrite(pin_cs, 1);  // de-assert /CS
  digitalWrite(pin_wr, 1);  // de-assert /WR

  // use PWM hardware to generate 3.5MHz clock on pin 3
  analogWriteResolution(2);
  analogWriteFrequency(3, 3579545);  // 1/4 14.31818MHz
  analogWrite(3, 2);

  pinMode(pin_sync, INPUT);
  pinMode(pin_clk, INPUT);
  pinMode(pin_data, INPUT);

  // delay(100);

  // setup inst:
  // f9 15 00 21 01 | ff 01 08 00 02 | 02 | 00 00 00 00 00

  const uint8_t op1 = 3;
  const uint8_t op2 = 0;
  const uint8_t chan = 0;

  ym3812_write(0x01, 0x20);  // test off, wave select enable(!)
  ym3812_write(0x08, 0x00);  // disable CSM
  ym3812_write(0xbd, 0xc0);  // full vib/tremolo depth
  
  ym3812_write(0x60 + op1, 0x4f);  // ad
  ym3812_write(0x80 + op1, 0x0f);  // sr
  ym3812_write(0x40 + op1, 0x00);  // ksl / output level
  ym3812_write(0x20 + op1, 0x21);  // multiplier, vibrato, sustain 0x20
  ym3812_write(0xe0 + op1, 0x02);  // waveform (half sine)

  ym3812_write(0x60 + op2, 0xff);  // ad
  ym3812_write(0x80 + op2, 0xff);  // sr
  ym3812_write(0x40 + op2, 0x3f);  // ksl / output level  (silence, no modulation)
  ym3812_write(0x20 + op2, 0x00);  // multiplier + vibrato etc
  ym3812_write(0xe0 + op2, 0x00);  // waveform (sine)
  ym3812_write(0xc0 + chan, 0x00);  // synthtype + feedback

  ym3812_write(0xa0, 0);  // f-num 512 octave 1

  delay(2000);
  ym3812_write(0xb0, 0x20 | 0x06);  // f-num, octave, key on

  static uint16_t buf[30000];
  noInterrupts();
  // now, begin reading samples and streaming them out to the serial port!
  for (int sample = 0; sample < 30000; sample++) {
    // bit bang serial input; hopefully this is fast enough to not skip samples when we send
    // a serial output
    buf[sample] = ym3014b_read16();
  }
  interrupts();
  Serial.write("#YM3812#");
  Serial.write((uint8_t*) buf, sizeof(buf));
  ym3812_write(0xb0, 0x06);  // key off

}

void loop() {
}

