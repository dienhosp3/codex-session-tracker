# Vietnamese quota voice test pack

This folder is independent from the extension UI. It contains the exact WAV
segments used by the tracker and a Node script that joins them into complete
sentences.

Run from the repository root:

```powershell
node .\voice-test\test-voice.js
```

The generated files are in `voice-test/output`. Open any `.wav` file directly
with Windows Media Player. Use `-p 42` to generate one percentage, or add
`--large` to include the large-change prefix.

The pack uses the same raw PCM concatenation path as the extension. If the
speech still sounds separated, compare the individual files in `segments` with
the complete files in `output`.
