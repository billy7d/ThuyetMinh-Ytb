# Local model/license report

Checked: 2026-09-24. Upstream license evidence has been reviewed for the pinned
revisions below. The operator-approved model set is installed outside the repo
at `E:\VietDub-AI\models`; its 25 artifacts have verified local hashes/size and
the backend model manager reports all components ready. Real CPU inference and
synthetic-audio gateway tests have run. The checked-in example manifest remains
a template with placeholders and is not the operator manifest.

| Component | Pinned artifact | License evidence and decision |
|---|---|---|
| STT | [`Systran/faster-whisper-base.en`](https://huggingface.co/Systran/faster-whisper-base.en/tree/3d3d5dee26484f91867d81cb899cfcf72b96be6c), revision `3d3d5dee26484f91867d81cb899cfcf72b96be6c` | The pinned model card declares MIT and identifies the CTranslate2 conversion. The [faster-whisper runtime](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE) is MIT. Distribution and commercial use are marked verified for this artifact selection. |
| Translation | [`Helsinki-NLP/opus-mt-en-vi`](https://huggingface.co/Helsinki-NLP/opus-mt-en-vi/tree/989c9fb9ec63987901022baf0182dcec3e149be6), revision `989c9fb9ec63987901022baf0182dcec3e149be6` | The model page declares Apache-2.0 and English→Vietnamese. [Transformers](https://github.com/huggingface/transformers/blob/main/LICENSE) is Apache-2.0 and [SentencePiece](https://github.com/google/sentencepiece/blob/master/LICENSE) is Apache-2.0. Distribution and commercial use are marked verified for this artifact selection. |
| Vietnamese TTS | [`pnnbao-ump/VieNeu-TTS-v3-Turbo`](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/tree/5f2a3e93092efaba9153253ff5f2e6a8e810e4f2), revision `5f2a3e93092efaba9153253ff5f2e6a8e810e4f2` | The official model card declares Apache-2.0 for weights, ONNX exports, configuration, tokenizer and bundled preset voice assets, and explicitly permits commercial use of generated audio with those presets. This worker uses a bundled preset and does not use voice cloning. |
| TTS codec | [`OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX/tree/ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae), revision `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` | The official ONNX repository declares Apache-2.0. Keep required license/attribution notices if redistributing it. |
| TTS phonemizer | `sea-g2p==0.10.0` | The upstream [`sea-g2p` repository](https://github.com/pnnbao97/sea-g2p/blob/main/LICENSE) carries Apache-2.0. This exact Python package version is pinned in `runtime/requirements-lock.txt`. |

These are free-to-download local artifacts; inference does not call a paid API
or hosted model service. License labels do not waive attribution/notice duties.
The training corpus details for VieNeu are not fully public; the model card's
rights statement covers the released weights and bundled presets used here.

## Integrity evidence and remaining scope

- The immutable revisions/upstream digests are listed in
  [`runtime/MODEL_SELECTION.md`](../runtime/MODEL_SELECTION.md) and cross-checked
  against the installed files and manifest. The operator manifest records both
  upstream identity and each local SHA-256/byte size.
- Model weights and the operator manifest are not committed. A fresh install
  must obtain separate user consent, re-download only pinned artifacts, and
  perform its own verification; any mismatch must keep the component unavailable.
- Real worker inference and short synthetic gateway runs are verified for this
  machine. Browser acceptance with human speech, license duties when redistributing
  artifacts, and a 30-minute soak remain separate unverified gates.
