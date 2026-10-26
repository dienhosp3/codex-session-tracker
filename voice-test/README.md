# Vietnamese quota voice test pack

This folder is independent from the extension UI. It contains the exact WAV
files used by the tracker and a Node script that produces complete test files.
Each percentage file already contains the full Vietnamese sentence. This is
deliberate: isolated clips made the speech engine reinterpret words such as
“ba” and “bảy” as letter names.

Run from the repository root:

```powershell
node .\voice-test\test-voice.js
```

The generated files are in `voice-test/output`. Open any `.wav` file directly
with Windows Media Player. Use `-p 42` to generate one percentage, or add
`--large` to include the large-change prefix.

The pack uses the same raw PCM playback and concatenation path as the
extension. The `segments` folder contains `percent_0.wav` through
`percent_100.wav` plus `large_prefix.wav`; the default output samples are the
same files the extension uses.
