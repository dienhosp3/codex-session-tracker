# Vietnamese sound review artifact

Deliverable: `sound-review.html`, a standalone UTF-8 review file with six embedded
existing audio samples. No production sound or Tracker setting was changed.

Inventory verified from source and the installed Tracker 0.12.35 audio modules:

- One 1100 Hz / 180 ms beep implementation serves two initial waiting states:
  approval and user input. The review proposes one editable sentence per state.
  Simultaneous states can reuse those two recordings rather than add a third.
- Two MP3 alert files exist: retry-limit 429 and model capacity. Their code and
  binary hashes match the installed copies. Their audio durations are about
  3.18 and 22.83 seconds. They are not transcribed or assumed to be speech-free:
  each is initially excluded until the user confirms it needs replacement.
- Four existing Vietnamese speech groups are excluded: approval reminders,
  user-input reminders, remaining primary quota, and large-quota-change prefix.
  Existing WAV inventory contains 95 attention clips and 102 quota clips.
- Only relevant sound settings were used in the artifact: no custom MP3 paths
  are configured; quota speech is enabled with an eight-point change threshold.
  Current quota threshold/rate notifications have no assigned sound key and are
  explicitly identified as text-only rather than invented beep candidates.

The review supports selecting all/none/individual eligible items, editing phrases
and notes, confirming an MP3 already has Vietnamese speech, local draft storage,
selected-action JSON export/import, and an independently reopenable edited HTML.
Already-Vietnamese and unverified items cannot enter exported sound actions.

Real Edge checks passed at widths 1100, 700 and 360: selection behavior, Unicode,
draft reload, exclusion rules, JSON round-trip, standalone HTML round-trip,
blank selected-phrase validation, inert script-like edited text, embedded-audio
controls and layout without horizontal overflow. No browser errors or HTTP(S)
requests occurred. The rendered review was also visually inspected.

Scratch used the shared ACL helper and ordinary LEGION\SP3 token; browser handles
were closed and all run directories removed. Preview screenshots and downloaded
test exports were discarded. No new speech was generated, and no deployment,
installation or push was performed.

[Runtime provenance](../checkpoints/sound-review-20261109.json).
