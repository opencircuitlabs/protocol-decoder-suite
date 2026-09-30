import test from 'node:test';
import assert from 'node:assert/strict';
import { annotations, decode, decodeI2c, decodeSpi, decodeUart } from '../src/index.js';

function uartCapture(bytes, options = {}) {
  const spb = 10; const samples = Array(20).fill(1); const parity = options.parity ?? 'none';
  for (const byte of bytes) {
    samples.push(...Array(spb).fill(0)); const bits = [];
    for (let b = 0; b < 8; b++) { const value = (byte >> b) & 1; bits.push(value); samples.push(...Array(spb).fill(value)); }
    if (parity !== 'none') { const ones = bits.reduce((a,b)=>a+b,0); let value = parity === 'even' ? ones % 2 : 1 - ones % 2; if (options.badParity) value ^= 1; samples.push(...Array(spb).fill(value)); }
    samples.push(...Array(spb).fill(options.badStop ? 0 : 1), ...Array(spb).fill(1));
  }
  return { schemaVersion: 1, sampleRateHz: 100000, channels: [{ name: 'rx' }], samples };
}

function spiCapture(bytes) {
  const samples = [4, 4, 0]; // clk=bit0, mosi=bit1, cs=bit2
  for (const byte of bytes) for (let b = 7; b >= 0; b--) { const data = (byte >> b) & 1; samples.push(data << 1, (data << 1) | 1, data << 1); }
  samples.push(4, 4); return { sampleRateHz: 1000000, channels: [{ name: 'sck' }, { name: 'mosi' }, { name: 'cs' }], samples };
}

function i2cCapture(address, data, ack = 0) {
  const samples = [3, 3, 1]; // scl=bit0, sda=bit1; START
  const send = (value) => { for (let b = 7; b >= 0; b--) { const d = (value >> b) & 1; samples.push(d << 1, (d << 1) | 1, d << 1); } samples.push(ack << 1, (ack << 1) | 1, ack << 1); };
  send(address << 1); send(data); samples.push(0, 1, 3, 3); return { sampleRateHz: 1000000, channels: [{ name: 'scl' }, { name: 'sda' }], samples };
}

test('UART decodes multiple 8N1 frames LSB first', () => {
  const result = decodeUart(uartCapture([0x55, 0xa3]), { channel: 'rx', baudRate: 10000 });
  assert.deepEqual(result.summary.bytes, [0x55, 0xa3]); assert.equal(result.summary.errorCount, 0);
});
test('UART flags parity and framing errors independently', () => {
  const parity = decodeUart(uartCapture([0x31], { parity: 'even', badParity: true }), { channel: 'rx', baudRate: 10000, parity: 'even' });
  assert.deepEqual(parity.frames[0].errors, ['parity']);
  const framing = decodeUart(uartCapture([0x31], { badStop: true }), { channel: 'rx', baudRate: 10000 }); assert.ok(framing.frames[0].errors.includes('framing'));
});
test('UART rejects undersampled baud rates', () => assert.throws(() => decodeUart(uartCapture([]), { channel: 'rx', baudRate: 50000 }), /at least 3x/));
test('SPI mode zero decodes words while chip select is active', () => {
  const result = decodeSpi(spiCapture([0xa5, 0x3c]), { clock: 'sck', mosi: 'mosi', select: 'cs' });
  assert.deepEqual(result.transactions[0].words.map((w) => w.mosi), [0xa5, 0x3c]); assert.equal(result.summary.partialTransactions, 0);
});
test('SPI supports LSB-first words and reports partial tails', () => {
  const capture = spiCapture([0x80]); capture.samples.splice(-8, 6); const result = decodeSpi(capture, { clock: 'sck', mosi: 'mosi', select: 'cs', bitOrder: 'lsb' });
  assert.equal(result.summary.partialTransactions, 1); assert.ok(result.transactions[0].partialBits > 0);
});
test('I2C decodes address direction, data, and ACK', () => {
  const result = decodeI2c(i2cCapture(0x50, 0x33), { clock: 'scl', data: 'sda' });
  assert.equal(result.transactions.length, 1); assert.equal(result.transactions[0].bytes[0].address, 0x50); assert.equal(result.transactions[0].bytes[0].direction, 'write'); assert.equal(result.transactions[0].bytes[1].value, 0x33); assert.equal(result.summary.nackCount, 0);
});
test('I2C reports NACK and missing stop', () => {
  const capture = i2cCapture(0x20, 0x00, 1); capture.samples.splice(-4); const result = decodeI2c(capture, { clock: 'scl', data: 'sda' });
  assert.equal(result.summary.nackCount, 2); assert.ok(result.transactions[0].errors.includes('missing-stop'));
});
test('generic dispatcher selects protocols and rejects unsupported names', () => {
  assert.equal(decode(spiCapture([1]), { protocol: 'spi', clock: 'sck', mosi: 'mosi', select: 'cs' }).protocol, 'spi');
  assert.throws(() => decode(spiCapture([]), { protocol: 'can' }), /Unsupported protocol/);
});
test('annotations create renderer-neutral labels and severities', () => {
  const uart = decodeUart(uartCapture([0x41]), { channel: 'rx', baudRate: 10000 }); assert.equal(annotations(uart)[0].label, '0x41');
  const i2c = decodeI2c(i2cCapture(0x50, 0x33, 1), { clock: 'scl', data: 'sda' }); assert.ok(annotations(i2c).some((a) => a.severity === 'warning'));
});
test('unknown channels and incomplete configuration fail clearly', () => {
  assert.throws(() => decodeUart(uartCapture([]), { channel: 'tx', baudRate: 9600 }), /Unknown channel/);
  assert.throws(() => decodeSpi(spiCapture([]), { clock: 'sck' }), /At least one/);
});
