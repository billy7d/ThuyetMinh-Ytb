# Local model/license report

Checked: 2026-09-21. This is an upstream review, not a release clearance. The manifest remains `UNVERIFIED` until exact revisions, every artifact checksum and all dependency/voice terms are recorded.

| Component | Candidate | Upstream evidence | Current decision |
|---|---|---|---|
| STT | `whisper.cpp` with an English Whisper GGML weight | [whisper.cpp LICENSE](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE) states MIT for the code; [model instructions](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) distinguish converted model files and their sources. | Code is a candidate. Weight/model-card terms, exact revision and checksum must be checked before distribution. |
| Translation | `Helsinki-NLP/opus-mt-en-vi` | [Official model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-vi) identifies Apache-2.0, English→Vietnamese target metadata and SentencePiece preprocessing. | Candidate retained. Pin the model revision and all tokenizer/weight files; measure quality before selecting a profile. |
| Vietnamese TTS | `pnnbao-ump/VieNeu-TTS` | [Official model page](https://huggingface.co/pnnbao-ump/VieNeu-TTS) currently identifies Apache-2.0. The [official repository](https://github.com/pnnbao97/VieNeu-TTS) documents multiple generations, codecs, preset voices and that later proprietary versions are not open-source. | Use only an exact open model/revision after separately checking codec, tokenizer, voice assets and redistribution/commercial terms. Do not substitute the older 0.3B candidate automatically. |

## Required manifest evidence

For each component, `models/manifest.json` must record:

- model ID, upstream URL and immutable revision/commit;
- every downloaded file, byte size and SHA-256;
- model, code, tokenizer, codec and voice licenses;
- distribution and commercial-use decisions with the date/source checked.

The runtime refuses `unknown` or `restricted` distribution/commercial-use values. A model being downloadable without payment is not sufficient evidence of redistribution or commercial-use permission.
