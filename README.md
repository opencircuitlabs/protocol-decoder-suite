# Protocol Decoder Suite

Deterministic UART, SPI, and I²C decoders for packed digital captures. The suite consumes the versioned capture model used by [`logic-analyzer-core`](https://github.com/opencircuitlabs/logic-analyzer-core) and returns structured transactions plus renderer-neutral waveform annotations.

No native toolchain or runtime dependency is required, so the same decoders work in test runners, server pipelines, and browser bundles.

## Quick start

```bash
npm install
npm test
node src/cli.js capture.json decoder.json decoded.json
```

```js
import { decode, annotations } from '@opencircuitlabs/protocol-decoder-suite';

const result = decode(capture, {
  protocol: 'uart',
  channel: 'rx',
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
});

const overlays = annotations(result);
```

## Supported protocols

### UART

- 5–9 data bits, LSB-first;
- normal or inverted polarity;
- none, even, odd, mark, or space parity;
- 1, 1.5, or 2 stop bits;
- parity and framing errors attached to individual frames;
- rejection of captures sampled below three samples per bit.

### SPI

- modes 0–3 with correct leading/trailing sampling edges;
- MOSI, MISO, or simultaneous full-duplex decoding;
- optional active-high or active-low chip select;
- 1–32-bit words, MSB-first or LSB-first;
- transaction boundaries and explicitly marked partial tail words.

### I²C

- START, repeated START, and STOP detection;
- 7-bit address and read/write direction extraction;
- data bytes, ACK/NACK counts, and timestamps;
- incomplete-byte and missing-STOP diagnostics.

## Output model

Each decoder returns its normalized options, protocol-specific frames or transactions, and summary counts. Samples and timestamps remain attached to decoded data so a UI can place labels precisely. `annotations()` reduces any supported result to `{startSample, endSample, label, severity}` overlays.

Decoding is observational: the library never invents bytes from incomplete captures. Partial SPI words and incomplete I²C traffic remain visible with diagnostics, while UART frames retain the sampled bits that produced each value.

## License

MIT
