const valueAt = (capture, index, sample) => (capture.samples[Math.min(capture.samples.length - 1, Math.max(0, Math.round(sample)))] >>> index) & 1;

export function validateCapture(capture) {
  if (!capture || !Number.isFinite(capture.sampleRateHz) || capture.sampleRateHz <= 0) throw new Error('capture.sampleRateHz must be positive');
  if (!Array.isArray(capture.channels) || !capture.channels.length || capture.channels.length > 32) throw new Error('capture.channels must contain 1 to 32 channels');
  if (!Array.isArray(capture.samples)) throw new Error('capture.samples must be an array');
  return capture;
}

export function channelIndex(capture, name) {
  const index = capture.channels.findIndex((channel) => (typeof channel === 'string' ? channel : channel.name) === name);
  if (index < 0) throw new Error(`Unknown channel: ${name}`); return index;
}

const time = (capture, sample) => (capture.startTimeSeconds ?? 0) + sample / capture.sampleRateHz;
const bitsToNumber = (bits, order = 'msb') => order === 'lsb' ? bits.reduce((v, bit, i) => v | (bit << i), 0) : bits.reduce((v, bit) => (v << 1) | bit, 0);

export function decodeUart(input, options) {
  const capture = validateCapture(input); const rx = channelIndex(capture, options.channel); const baud = options.baudRate;
  if (!Number.isFinite(baud) || baud <= 0 || capture.sampleRateHz / baud < 3) throw new Error('baudRate must be positive and sampled at least 3x');
  const dataBits = options.dataBits ?? 8; const stopBits = options.stopBits ?? 1; const parity = options.parity ?? 'none'; const inverted = Boolean(options.inverted);
  if (![5, 6, 7, 8, 9].includes(dataBits)) throw new Error('dataBits must be 5 through 9');
  if (!['none', 'even', 'odd', 'mark', 'space'].includes(parity)) throw new Error('Unsupported parity');
  if (![1, 1.5, 2].includes(stopBits)) throw new Error('stopBits must be 1, 1.5, or 2');
  const logical = (sample) => valueAt(capture, rx, sample) ^ (inverted ? 1 : 0); const spb = capture.sampleRateHz / baud; const frames = []; const warnings = [];
  for (let i = 1; i < capture.samples.length;) {
    if (logical(i - 1) === 1 && logical(i) === 0) {
      const start = i; const bits = []; const errors = [];
      if (logical(start + spb * 0.5) !== 0) { i++; continue; }
      for (let b = 0; b < dataBits; b++) bits.push(logical(start + spb * (1.5 + b)));
      let cursorBits = 1 + dataBits; let parityBit = null;
      if (parity !== 'none') {
        parityBit = logical(start + spb * (cursorBits + 0.5)); cursorBits++;
        const ones = bits.reduce((a, b) => a + b, 0); const expected = parity === 'even' ? ones % 2 : parity === 'odd' ? 1 - (ones % 2) : parity === 'mark' ? 1 : 0;
        if (parityBit !== expected) errors.push('parity');
      }
      const stopSamples = stopBits === 1.5 ? [cursorBits + 0.5, cursorBits + 1] : Array.from({ length: stopBits }, (_, n) => cursorBits + 0.5 + n);
      if (stopSamples.some((offset) => logical(start + spb * offset) !== 1)) errors.push('framing');
      const end = Math.min(capture.samples.length - 1, Math.ceil(start + spb * (cursorBits + stopBits)));
      frames.push({ index: frames.length, startSample: start, endSample: end, startTimeSeconds: time(capture, start), endTimeSeconds: time(capture, end), value: bitsToNumber(bits, 'lsb'), bits, parityBit, errors });
      i = Math.max(i + 1, end);
    } else i++;
  }
  if (!frames.length) warnings.push('No UART start bits found');
  return { protocol: 'uart', options: { channel: options.channel, baudRate: baud, dataBits, parity, stopBits, inverted }, frames, warnings, summary: { frameCount: frames.length, errorCount: frames.filter((frame) => frame.errors.length).length, bytes: frames.filter((frame) => !frame.errors.length && dataBits <= 8).map((frame) => frame.value) } };
}

export function decodeSpi(input, options) {
  const capture = validateCapture(input); const clockIndex = channelIndex(capture, options.clock); const mosiIndex = options.mosi ? channelIndex(capture, options.mosi) : null; const misoIndex = options.miso ? channelIndex(capture, options.miso) : null; const selectIndex = options.select ? channelIndex(capture, options.select) : null;
  if (mosiIndex == null && misoIndex == null) throw new Error('At least one of mosi or miso is required');
  const mode = options.mode ?? 0; const bitsPerWord = options.bitsPerWord ?? 8; const bitOrder = options.bitOrder ?? 'msb'; const selectActive = options.selectActive ?? 0;
  if (![0, 1, 2, 3].includes(mode)) throw new Error('SPI mode must be 0 through 3'); if (!Number.isInteger(bitsPerWord) || bitsPerWord < 1 || bitsPerWord > 32) throw new Error('bitsPerWord must be 1 through 32'); if (!['msb', 'lsb'].includes(bitOrder)) throw new Error('bitOrder must be msb or lsb');
  const cpol = mode >> 1; const cpha = mode & 1; const sampleRising = cpha === 0 ? cpol === 0 : cpol === 1; const transactions = []; let current = null;
  const selected = (sample) => selectIndex == null || valueAt(capture, selectIndex, sample) === selectActive;
  for (let sample = 1; sample < capture.samples.length; sample++) {
    const isSelected = selected(sample);
    if (isSelected && !current) current = { startSample: sample, startTimeSeconds: time(capture, sample), words: [], partialBits: 0, _mosi: [], _miso: [] };
    if (!isSelected && current) { finishSpi(current, capture, sample, bitsPerWord, bitOrder); transactions.push(current); current = null; continue; }
    if (!isSelected) continue;
    const before = valueAt(capture, clockIndex, sample - 1); const after = valueAt(capture, clockIndex, sample); const edge = sampleRising ? before === 0 && after === 1 : before === 1 && after === 0;
    if (!edge) continue;
    if (mosiIndex != null) current._mosi.push(valueAt(capture, mosiIndex, sample)); if (misoIndex != null) current._miso.push(valueAt(capture, misoIndex, sample));
    if ((current._mosi.length || current._miso.length) === bitsPerWord) pushSpiWord(current, bitsPerWord, bitOrder, sample);
  }
  if (current) { finishSpi(current, capture, capture.samples.length - 1, bitsPerWord, bitOrder); transactions.push(current); }
  return { protocol: 'spi', options: { ...options, mode, bitsPerWord, bitOrder, selectActive }, transactions, summary: { transactionCount: transactions.length, wordCount: transactions.reduce((n, tx) => n + tx.words.length, 0), partialTransactions: transactions.filter((tx) => tx.partialBits).length } };
}
function pushSpiWord(tx, bitsPerWord, bitOrder, sample) { tx.words.push({ sample, mosi: tx._mosi.length ? bitsToNumber(tx._mosi, bitOrder) : null, miso: tx._miso.length ? bitsToNumber(tx._miso, bitOrder) : null, bits: bitsPerWord }); tx._mosi = []; tx._miso = []; }
function finishSpi(tx, capture, sample, bitsPerWord, bitOrder) { const count = Math.max(tx._mosi.length, tx._miso.length); if (count) { tx.partialBits = count; pushSpiWord(tx, count, bitOrder, sample); } tx.endSample = sample; tx.endTimeSeconds = time(capture, sample); delete tx._mosi; delete tx._miso; }

export function decodeI2c(input, options) {
  const capture = validateCapture(input); const scl = channelIndex(capture, options.clock); const sda = channelIndex(capture, options.data); const transactions = []; const events = []; let transaction = null; let bits = []; let byteIndex = 0;
  const startTx = (sample, repeated) => { if (!transaction) transaction = { startSample: sample, startTimeSeconds: time(capture, sample), repeatedStart: repeated, bytes: [], errors: [] }; else { transaction.events ??= []; transaction.events.push({ type: 'repeated-start', sample }); bits = []; byteIndex = 0; } events.push({ type: repeated ? 'repeated-start' : 'start', sample, timeSeconds: time(capture, sample) }); };
  for (let sample = 1; sample < capture.samples.length; sample++) {
    const prevScl = valueAt(capture, scl, sample - 1); const nowScl = valueAt(capture, scl, sample); const prevSda = valueAt(capture, sda, sample - 1); const nowSda = valueAt(capture, sda, sample);
    if (prevSda === 1 && nowSda === 0 && nowScl === 1) { startTx(sample, Boolean(transaction)); continue; }
    if (prevSda === 0 && nowSda === 1 && nowScl === 1 && transaction) { if (bits.length) transaction.errors.push('incomplete-byte'); transaction.endSample = sample; transaction.endTimeSeconds = time(capture, sample); transactions.push(transaction); events.push({ type: 'stop', sample, timeSeconds: time(capture, sample) }); transaction = null; bits = []; byteIndex = 0; continue; }
    if (transaction && prevScl === 0 && nowScl === 1) {
      bits.push(nowSda);
      if (bits.length === 9) { const value = bitsToNumber(bits.slice(0, 8)); const ack = bits[8] === 0; const entry = { index: byteIndex, sample, value, ack, kind: byteIndex === 0 ? 'address' : 'data' }; if (byteIndex === 0) { entry.address = value >> 1; entry.direction = value & 1 ? 'read' : 'write'; } transaction.bytes.push(entry); events.push({ type: 'byte', ...entry, timeSeconds: time(capture, sample) }); bits = []; byteIndex++; }
    }
  }
  if (transaction) { if (bits.length) transaction.errors.push('incomplete-byte'); transaction.errors.push('missing-stop'); transaction.endSample = capture.samples.length - 1; transaction.endTimeSeconds = time(capture, transaction.endSample); transactions.push(transaction); }
  return { protocol: 'i2c', options: { clock: options.clock, data: options.data }, transactions, events, summary: { transactionCount: transactions.length, byteCount: transactions.reduce((n, tx) => n + tx.bytes.length, 0), nackCount: transactions.reduce((n, tx) => n + tx.bytes.filter((b) => !b.ack).length, 0), errorCount: transactions.reduce((n, tx) => n + tx.errors.length, 0) } };
}

export function decode(input, config) {
  if (!config?.protocol) throw new Error('config.protocol is required');
  if (config.protocol === 'uart') return decodeUart(input, config);
  if (config.protocol === 'spi') return decodeSpi(input, config);
  if (config.protocol === 'i2c') return decodeI2c(input, config);
  throw new Error(`Unsupported protocol: ${config.protocol}`);
}

export function annotations(result) {
  if (result.protocol === 'uart') return result.frames.map((frame) => ({ startSample: frame.startSample, endSample: frame.endSample, label: frame.errors.length ? `ERR ${frame.errors.join(',')}` : `0x${frame.value.toString(16).padStart(2, '0')}`, severity: frame.errors.length ? 'error' : 'info' }));
  if (result.protocol === 'spi') return result.transactions.flatMap((tx) => tx.words.map((word) => ({ startSample: word.sample, endSample: word.sample, label: [word.mosi != null && `MOSI 0x${word.mosi.toString(16)}`, word.miso != null && `MISO 0x${word.miso.toString(16)}`].filter(Boolean).join(' · '), severity: tx.partialBits ? 'warning' : 'info' })));
  return result.events.map((event) => ({ startSample: event.sample, endSample: event.sample, label: event.type === 'byte' ? `${event.kind === 'address' ? `${event.direction} 0x${event.address.toString(16)}` : `0x${event.value.toString(16)}`} ${event.ack ? 'ACK' : 'NACK'}` : event.type.toUpperCase(), severity: event.ack === false ? 'warning' : 'info' }));
}
